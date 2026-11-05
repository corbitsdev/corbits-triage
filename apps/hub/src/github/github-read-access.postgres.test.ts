// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { authorize } from "@intx/authz";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createGrantStore, dropSchema, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { TRIAGE_MANAGERS, TRIAGE_ROLE, triageStopped, type ActionKind, type PrTriageRow } from "@corbits/triage-contracts";
import { doEffectId } from "@corbits/triage-workflows/logic/actions";
import { guardedApp } from "../integrations/test-app.js";
import { migrateTriageTables } from "../triage-db.js";
import { createAuditLog } from "../audit-log.js";
import { createGithubHeldDos } from "./held-dos.js";
import { DEFAULT_RECONCILE_POLICY } from "./reconcile-plan.js";
import type { TriageStateStore } from "./triage-state-store.js";
import { createGithubOpenPulls, createOpenPullsCache } from "./open-pulls.js";
import { createTenantOpenPrs } from "./tenant-open-heads.js";
import { createGithubPrActions } from "./pr-actions.js";
import { createGithubPrDetails } from "./pr-details.js";
import { createRepoReads } from "./repo-reads.js";
import { createTriageStats } from "./triage-stats.js";
import { createTriageTimeline } from "./triage-timeline.js";
import { createTriageVerdicts } from "./triage-verdicts.js";
import { verdictRecord, type VerdictRecord } from "./verdict-record-store.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_read_access";
const REPO = "acme/widgets";
const HEAD = "abc1230000000000000000000000000000000000";
const testSchema = `corbits_read_access_${randomBytes(6).toString("hex")}`;
const requested: string[] = [];
const reviewed: unknown[] = [];
let reviews: unknown[] = [];
let checkRuns: unknown[] = [];

const READS: Record<string, unknown> = {
  [`/repos/${REPO}/pulls`]: [
    { number: 8, title: "Fix the widget", draft: false, user: { login: "octocat" }, head: { sha: HEAD } },
  ],
  [`/repos/${REPO}/pulls/8`]: {
    number: 8, title: "Fix the widget", state: "open", body: "", user: { login: "octocat" }, head: { sha: HEAD, ref: "fix" }, base: { sha: "base" }, mergeable: true, labels: [], assignees: [] },
  [`/repos/${REPO}/pulls/8/commits`]: [{ sha: HEAD, commit: { message: "fix: the widget" } }],
  [`/repos/${REPO}/pulls/8/files`]: [{ filename: "src/widget.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+fixed" }],
  [`/repos/${REPO}/issues/8/comments`]: [],
  [`/repos/${REPO}/commits/${HEAD}/status`]: { statuses: [] },
};

async function github(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  requested.push(`${req.method} ${pathname}`);
  if (pathname === "/app/installations/1/access_tokens") return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  if (req.method === "GET" && pathname in READS) return Response.json(READS[pathname]);
  if (pathname === `/repos/${REPO}/installation`) return Response.json({ id: 1 });
  if (req.method === "GET" && pathname === `/repos/${REPO}/pulls/8/reviews`) return Response.json(reviews);
  if (req.method === "POST" && pathname === "/graphql") return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  if (req.method === "GET" && pathname === `/repos/${REPO}/commits/${HEAD}/check-runs`) return Response.json({ total_count: checkRuns.length, check_runs: checkRuns });
  if (req.method === "POST" && pathname === `/repos/${REPO}/pulls/8/reviews`) {
    reviewed.push(await req.json());
    return Response.json({ id: 1, state: "APPROVED" });
  }
  return new Response(null, { status: 404 });
}

const server = Bun.serve({ port: 0, fetch: github });
const githubApiOrigin = `http://127.0.0.1:${server.port}`;
const handle = createDB({ ...TEST_DB, schema: testSchema });
const cipher = createEnvKeyCredentialCipher(new Uint8Array(32).fill(7));
const grants = createGrantStore(handle.db);

async function sessionOf(headers: Headers) {
  return { user: { id: headers.get("x-test-user")! }, session: { id: "ses" } } as never;
}

async function authorizePortal(principalId: string, tenantId: string, resource: string, action: string): Promise<boolean> {
  return (await authorize(grants, principalId, tenantId, resource, action, { conditions: HUB_CONDITION_REGISTRY })).effect === "allow";
}

const deps = { db: handle.db, cipher, onKeyMoved: noKeyPush, authorize: authorizePortal, githubApiOrigin };
/** Triage rows kept in memory, with the version the store would give each write. */
function triageRows(): TriageStateStore & { rows: PrTriageRow[] } {
  let version = 0;
  const kept = {
    rows: [] as PrTriageRow[],
    async load() {
      return { rows: kept.rows, version: version === 0 ? null : { artifactId: "art_state", version } };
    },
    async save(_tenantId: string, _repo: string, rows: PrTriageRow[]) {
      kept.rows = rows;
      version += 1;
      return { artifactId: "art_state", version };
    },
  };
  return kept;
}
/** The listener takes every approval here, so no head is held. */
const NOT_HELD = { store: triageRows(), policy: DEFAULT_RECONCILE_POLICY, now: () => new Date(), retry() {} };
const list = createTenantOpenPrs({ ...deps, tenantBitbucket: async () => undefined });
const openPulls = createGithubOpenPulls({ ...deps, list, cache: createOpenPullsCache(() => new Date()) });
const reads = createRepoReads(() => new Date());
const prDetails = createGithubPrDetails({ ...deps, tenantBitbucket: async () => undefined, reads, log() {} });
const prActions = createGithubPrActions({
  ...deps,
  changed: reads.changed,
  log() {},
  async readCheckPack() { return { status: "missing" } as const; },
  codeReviews: { async latest() { return { review: null, completed: null, carriedTo: null }; } },
});

function member(user: string) {
  return { tenantId: TENANT, principalId: user.replace("usr_", "prn_") };
}

beforeAll(async () => {
  await runMigrations(TEST_DB, { schema: testSchema });
  const db = handle.db;
  await db.insert(schema.tenant).values({
    id: TENANT, name: "Read access", slug: "read-access", domain: "read-access.test",
    config: { corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true, installationId: 1 }, { name: "acme/other", connected: false }, { name: "PROJ/api", source: "bitbucket-datacenter", connected: true, enabled: true }] } },
  });
  await db.insert(schema.principal).values([
    { id: "prn_member", tenantId: TENANT, kind: "user", refId: "usr_member", status: "active" },
    { id: "prn_user", tenantId: TENANT, kind: "user", refId: "usr_user", status: "active" },
    { id: "prn_admin", tenantId: TENANT, kind: "user", refId: "usr_admin", status: "active" },
    { id: "prn_approver", tenantId: TENANT, kind: "user", refId: "usr_approver", status: "active" },
    { id: "prn_lent", tenantId: TENANT, kind: "user", refId: "usr_lent", status: "active" },
    { id: "prn_merger", tenantId: TENANT, kind: "user", refId: "usr_merger", status: "active" },
  ]);
  await db.insert(schema.role).values([
    { id: "rol_member", tenantId: TENANT, name: "member", isSystem: true },
    { id: "rol_admin", tenantId: TENANT, name: "admin", isSystem: true },
    { id: "rol_triage", tenantId: TENANT, name: TRIAGE_ROLE, isSystem: true },
  ]);
  await db.insert(schema.principalRole).values([
    { principalId: "prn_member", roleId: "rol_member" },
    { principalId: "prn_admin", roleId: "rol_admin" },
    { principalId: "prn_lent", roleId: "rol_triage" },
  ]);
  await db.insert(schema.grant).values([
    { id: "grt_member_read", tenantId: TENANT, roleId: "rol_member", resource: "*", action: "read", effect: "allow", origin: "system" },
    { id: "grt_admin_read", tenantId: TENANT, roleId: "rol_admin", resource: "*", action: "read", effect: "allow", origin: "system" },
    { id: "grt_admin_manage", tenantId: TENANT, roleId: "rol_admin", resource: "*", action: "manage", effect: "allow", origin: "system" },
    { id: "grt_user_use", tenantId: TENANT, principalId: "prn_user", resource: "credential:crd_github", action: "use", effect: "allow", origin: "system" },
    { id: "grt_approver_use", tenantId: TENANT, principalId: "prn_approver", resource: "credential:crd_github", action: "use", effect: "allow", origin: "system" },
    { id: "grt_approver_approve", tenantId: TENANT, principalId: "prn_approver", resource: "triage-do:approve:*", action: "invoke", effect: "allow", origin: "system" },
    { id: "grt_approver_labels", tenantId: TENANT, principalId: "prn_approver", resource: `triage-do:labels:github:${REPO}`, action: "invoke", effect: "allow", origin: "system" },
    { id: "grt_approver_comment", tenantId: TENANT, principalId: "prn_approver", resource: `triage-do:comment:github:${REPO}`, action: "invoke", effect: "allow", origin: "system" },
    { id: "grt_lent_use", tenantId: TENANT, principalId: "prn_lent", resource: "credential:crd_github", action: "use", effect: "allow", origin: "system" },
    { id: "grt_merger_use", tenantId: TENANT, principalId: "prn_merger", resource: "credential:crd_github", action: "use", effect: "allow", origin: "system" },
    { id: "grt_merger_merge", tenantId: TENANT, principalId: "prn_merger", resource: `triage-do:merge:github:${REPO}`, action: "invoke", effect: "allow", origin: "system" },
    { id: "grt_triage_approve", tenantId: TENANT, roleId: "rol_triage", resource: "triage-do:approve:*", action: "invoke", effect: "allow", origin: "role" },
  ]);
  await db.insert(schema.provider).values({ id: "prv_github", tenantId: TENANT, name: "github", plugin: "http", apiBaseUrl: githubApiOrigin });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  await db.insert(schema.credential).values({
    id: "crd_github", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key",
    secret: await cipher.encrypt(JSON.stringify({ appId: "1", privateKey }), credentialAad("crd_github", "secret")), status: "active", metadata: { appSlug: "triage" },
  });
}, 120_000);

afterAll(async () => {
  server.stop(true);
  await handle.close();
  await dropSchema(TEST_DB, { schema: testSchema });
});

test("PostgreSQL: holding read or use on the GitHub credential reads pull requests; acting needs use", async () => {
  for (const user of ["usr_member", "usr_user"]) {
    const pulls = await openPulls(member(user));
    expect(pulls.status).toBe(200);
    expect(await pulls.json()).toMatchObject({ repos: [{ repo: REPO, prs: [{ number: 8 }] }, { repo: "PROJ/api", source: "bitbucket-datacenter", prs: [] }] });

    const details = await prDetails(new Request(`http://hub.test/pull?repo=${REPO}&number=8`), member(user));
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({ pr: { number: 8 }, files: [{ path: "src/widget.ts" }] });
  }

  const act = await prActions({ action: "merge", repo: REPO, number: 8 }, member("usr_member"));
  expect(act.status).toBe(403);
  expect(await act.json()).toEqual({ error: { code: "forbidden", message: "You do not have access to the GitHub App credential." } });
  expect(requested.some((line) => line.startsWith("PUT"))).toBe(false);
}, 60_000);

test("PostgreSQL: pull request details serve only repositories connected to the workspace", async () => {
  const res = await prDetails(new Request("http://hub.test/pull?repo=acme/other&number=8"), member("usr_member"));
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "repo_not_connected" } });
});

test("PostgreSQL: approving needs the approve Do grant on top of use, and pins the review to the head shown; merging needs the merge grant", async () => {
  const approve = { action: "review", event: "APPROVE", repo: REPO, number: 8, body: "", headSha: HEAD } as const;
  const refused = await prActions(approve, member("usr_user"));
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: { code: "forbidden", message: "You do not have the grant for this kind of Do in this repository." } });
  expect(reviewed).toEqual([]);

  const approved = await prActions(approve, member("usr_approver"));
  expect(approved.status).toBe(200);
  expect(reviewed).toEqual([{ body: "", event: "APPROVE", commit_id: HEAD }]);

  const merge = await prActions({ action: "merge", repo: REPO, number: 8 }, member("usr_approver"));
  expect(merge.status).toBe(403);
  expect(await merge.json()).toEqual({ error: { code: "forbidden", message: "You do not have the grant for this kind of Do in this repository." } });

  const lent = await prActions(approve, member("usr_lent"));
  expect(lent.status).toBe(403);
  expect(await lent.json()).toEqual({ error: { code: "forbidden", message: "Triage's own role cannot act for a person. Remove it from this member first." } });
  expect(reviewed).toHaveLength(1);
});

test("PostgreSQL: the portal's Merge is refused while a reviewer requests changes or CI has failed, and nothing is merged", async () => {
  const merge = { action: "merge", repo: REPO, number: 8, headSha: HEAD } as const;
  try {
    reviews = [{ user: { login: "hubot" }, state: "CHANGES_REQUESTED", commit_id: HEAD }];
    checkRuns = [{ name: "ci", status: "completed", conclusion: "success" }];
    const changes = await prActions(merge, member("usr_merger"));
    expect({ status: changes.status, body: await changes.json() }).toMatchObject({ status: 409, body: { error: { code: "merge_refused", message: expect.stringContaining("hubot") } } });

    reviews = [];
    checkRuns = [{ name: "ci", status: "completed", conclusion: "failure" }];
    const failing = await prActions(merge, member("usr_merger"));
    expect({ status: failing.status, body: await failing.json() }).toMatchObject({ status: 409, body: { error: { code: "merge_refused", message: expect.stringContaining("CI has failed") } } });
    expect(requested).not.toContain(`PUT /repos/${REPO}/pulls/8/merge`);
  } finally {
    reviews = [];
    checkRuns = [];
  }
});

test("PostgreSQL: every verdict route needs workflow-run read, which holding the GitHub credential does not give", async () => {
  const unused = {} as never;
  const app = guardedApp(handle.db, sessionOf, grants, {
    triageVerdicts: createTriageVerdicts({ ...deps, list, verdicts: unused, managerRuns: unused, openPulls: unused, triageState: unused, now: unused }),
    triageTimeline: createTriageTimeline({ db: unused, verdicts: unused }),
    triageStats: createTriageStats({ verdicts: unused, outcomes: unused, now: unused, log: unused }),
    audit: createAuditLog({ db: unused, runReader: unused, authorize: unused, workflows: ["pr-triage"] }),
  });
  for (const route of ["triage-verdicts", "triage-timeline", "triage-stats", "audit"]) {
    const res = await app.request(`/api/integrations/${route}/${TENANT}?repo=${REPO}&number=8`, { headers: { "x-test-user": "usr_user" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
  }
});

test("PostgreSQL: approving a held Do needs its kind's grant and hands the listener who approved it; it stands only on the newest judged verdict; a written or unrunnable Do is refused, and none goes out without a listener", async () => {
  await handle.db.insert(schema.workflowDefinition).values({ id: "wfd_triage", tenantId: TENANT, name: "pr-triage", status: "stopped" });
  await handle.db.insert(schema.workflowRun).values([
    { id: "wfr_anchor", definitionId: "wfd_triage", anchorRunId: "wfr_anchor", tenantId: TENANT, status: "deployed" },
    { id: "wfr_verdict", definitionId: "wfd_triage", anchorRunId: "wfr_anchor", tenantId: TENANT, status: "completed" },
  ]);
  function held(id: string, kind: ActionKind, target: Record<string, unknown>) {
    const step = { list: "pass" as const, index: Number(id), kind, reason: "passes the repository's policy", target, held: true };
    return { ...step, effectId: doEffectId({ repo: REPO, number: 8, headSha: HEAD, list: step.list, index: step.index, kind, target: target as never }) };
  }
  const ship = held("0", "approve", {});
  const tag = held("1", "labels", { labels: ["api"] });
  const written = { ...held("2", "labels", { labels: ["done"] }), status: "done" };
  const derived = held("3", "labels", { unresolved: "derive", from: "type" });
  const verdict = { repo: REPO, number: 8, headSha: HEAD, request: { repo: REPO, number: 8, labels: [], owned: [], comment: "" }, actions: [ship, tag, written, derived] };
  const events = [{ seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "evaluate", output: { ref: `inline:${JSON.stringify(verdict)}` } } }];
  const mailed: unknown[] = [];
  let listening = true;
  let recorded: Array<Pick<VerdictRecord, "runId" | "degraded" | "runStatus">> = [];
  const heldDos = createGithubHeldDos({
    ...deps,
    ...NOT_HELD,
    runReader: { async readRunEvents() { return events; } },
    verdicts: { async forPull() { return recorded as VerdictRecord[]; }, async forHostedPull() { return recorded as VerdictRecord[]; } },
    async toListener(_tenantId, payload) {
      if (listening) mailed.push(payload);
      return listening;
    },
    async passRequest() { throw new Error("pr-triage's verdict is in its run's log"); },
    log() {},
  });
  async function approve(user: string, step: { effectId: string; kind: ActionKind }, runId = "wfr_verdict") {
    const res = await heldDos({ runId, repo: REPO, number: 8, effectId: step.effectId, kind: step.kind }, member(user));
    return { status: res.status, body: await res.json() };
  }

  expect(await approve("usr_user", ship, "wfr_missing")).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  expect(await approve("usr_approver", { ...tag, kind: "approve" })).toMatchObject({ status: 409, body: { error: { code: "kind_mismatch" } } });
  expect(await approve("usr_approver", written)).toMatchObject({ status: 409, body: { error: { code: "do_not_held" } } });
  expect(await approve("usr_approver", derived)).toMatchObject({ status: 409, body: { error: { code: "do_not_runnable" } } });
  expect(await approve("usr_user", tag)).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  expect(await approve("usr_approver", tag)).toEqual({ status: 202, body: { status: "sent" } });
  expect(mailed).toEqual([{
    kind: "approve-do", runId: "wfr_verdict", principalId: "prn_approver", list: "pass", index: 1,
    request: verdict.request, step: { effectId: tag.effectId, headSha: HEAD, kind: "labels", target: { labels: ["api"] } },
  }]);

  recorded = [{ runId: "wfr_verdict", degraded: null, runStatus: "completed" }, { runId: "wfr_degraded", degraded: "error", runStatus: "completed" }, { runId: "wfr_failed", degraded: null, runStatus: "failed" }];
  expect((await approve("usr_approver", ship)).status).toBe(202);
  recorded.push({ runId: "wfr_newer", degraded: null, runStatus: "completed" });
  expect(await approve("usr_approver", ship)).toMatchObject({ status: 409, body: { error: { code: "verdict_superseded" } } });
  expect(mailed).toHaveLength(2);
  recorded.pop();
  listening = false;
  expect(await approve("usr_approver", ship)).toMatchObject({ status: 503, body: { error: { code: "service_not_running", message: triageStopped("github") } } });
});

test("PostgreSQL: a Bitbucket approval of a GitHub run is refused, and the same run still approves on GitHub", async () => {
  const tenantId = "tnt_cross_host_do";
  const target = {};
  const ship = { list: "pass" as const, index: 0, kind: "approve" as const, target, held: true, effectId: doEffectId({ repo: REPO, number: 8, headSha: HEAD, list: "pass", index: 0, kind: "approve", target }) };
  const verdict = { repo: REPO, number: 8, headSha: HEAD, request: { repo: REPO, number: 8, labels: [], owned: [], comment: "" }, actions: [ship] };
  const events = [{ seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "evaluate", output: { ref: `inline:${JSON.stringify(verdict)}` } } }];
  const mailed: unknown[] = [];
  const heldDos = createGithubHeldDos({
    ...deps,
    ...NOT_HELD,
    runReader: { async readRunEvents() { return events; } },
    verdicts: { async forPull() { return []; }, async forHostedPull() { return []; } },
    async toListener(_tenantId, payload) {
      mailed.push(payload);
      return true;
    },
    async passRequest() { throw new Error("pr-triage's verdict is in its run's log"); },
    log() {},
  });
  await handle.db.insert(schema.tenant).values({
    id: tenantId, name: "Cross host", slug: "cross-host-do", domain: "cross-host-do.test",
    config: { corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true, installationId: 1 }, { name: REPO, source: "bitbucket-datacenter", connected: true, enabled: true }] } },
  });
  await handle.db.insert(schema.principal).values({ id: "prn_cross", tenantId, kind: "user", refId: "usr_cross", status: "active" });
  await handle.db.insert(schema.grant).values({ id: "grt_cross_approve", tenantId, principalId: "prn_cross", resource: "triage-do:approve:*", action: "invoke", effect: "allow", origin: "system" });
  await handle.db.insert(schema.workflowDefinition).values([
    { id: "wfd_cross_gh", tenantId, name: "pr-triage", status: "stopped" },
    { id: "wfd_proj_gh", tenantId, name: TRIAGE_MANAGERS["bitbucket-datacenter"], status: "stopped" },
    { id: "wfd_proj_bb", tenantId, name: "triage-manager", status: "stopped" },
  ]);
  await handle.db.insert(schema.workflowRun).values([
    { id: "wfr_cross_gh", definitionId: "wfd_cross_gh", anchorRunId: "wfr_cross_gh", tenantId, status: "completed" },
    { id: "wfr_proj_gh", definitionId: "wfd_proj_gh", anchorRunId: "wfr_proj_gh", tenantId, status: "completed" },
    { id: "wfr_proj_bb", definitionId: "wfd_proj_bb", anchorRunId: "wfr_proj_bb", tenantId, status: "completed" },
  ]);
  function launched(anchorRunId: string, workflow: string) {
    return {
      anchorRunId, sessionId: `ses_${anchorRunId}`, deploymentDomain: "cross-host-do.test", sourceAuthorityPrincipalId: "prn_cross",
      frozenApprovalBundle: { projection: { id: workflow } }, sourceOfferingIds: [], defaultSourceOfferingId: "off_default", deployContent: {},
    };
  }
  await handle.db.insert(schema.workflowRunLaunchSpec).values([
    launched("wfr_proj_gh", TRIAGE_MANAGERS.github),
    launched("wfr_proj_bb", TRIAGE_MANAGERS["bitbucket-datacenter"]),
  ]);
  const body = { runId: "wfr_cross_gh", repo: REPO, number: 8, effectId: ship.effectId, kind: "approve" as const };
  const who = { tenantId, principalId: "prn_cross" };
  const planted = ["wfr_cross_gh", "wfr_proj_gh", "wfr_proj_bb"];
  await migrateTriageTables(handle.db, testSchema);
  try {
    const crossed = await heldDos({ ...body, source: "bitbucket-datacenter" }, who);
    expect(crossed.status).not.toBe(202);
    expect({ status: crossed.status, body: await crossed.json() }).toMatchObject({ status: 409, body: { error: { code: "run_host_mismatch" } } });
    expect(mailed).toEqual([]);

    const omitted = await heldDos(body, who);
    expect({ status: omitted.status, body: await omitted.json() }).toEqual({ status: 202, body: { status: "sent" } });
    const named = await heldDos({ ...body, source: "github" }, who);
    expect({ status: named.status, body: await named.json() }).toEqual({ status: 202, body: { status: "sent" } });
    expect(mailed).toHaveLength(2);
    expect(mailed.every((payload) => !Object.prototype.hasOwnProperty.call(payload, "repoSource"))).toBe(true);

    const sent = mailed.length;
    const namedBitbucket = await heldDos({ ...body, runId: "wfr_proj_gh", source: "bitbucket-datacenter" }, who);
    expect(namedBitbucket.status).not.toBe(202);
    expect({ status: namedBitbucket.status, body: await namedBitbucket.json() }).toMatchObject({ status: 409, body: { error: { code: "run_host_mismatch" } } });
    expect(mailed).toHaveLength(sent);

    const sharedName = await heldDos({ ...body, runId: "wfr_proj_bb" }, who);
    expect(sharedName.status).not.toBe(202);
    expect({ status: sharedName.status, body: await sharedName.json() }).toMatchObject({ status: 409, body: { error: { code: "run_host_mismatch" } } });
    expect(mailed).toHaveLength(sent);
  } finally {
    await handle.db.delete(verdictRecord).where(and(eq(verdictRecord.tenantId, tenantId), inArray(verdictRecord.runId, planted)));
  }
});
