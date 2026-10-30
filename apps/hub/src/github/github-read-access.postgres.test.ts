// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { authorize } from "@intx/authz";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createGrantStore, dropSchema, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { TRIAGE_ROLE, triageStopped, type ActionKind, type PrTriageRow } from "@corbits/triage-contracts";
import { doEffectId } from "@corbits/triage-workflows/logic/actions";
import { guardedApp } from "../integrations/test-app.js";
import { migrateTriageTables } from "../triage-db.js";
import { createAuditLog } from "../audit-log.js";
import { ListenerUnroutedError } from "./deployment.js";
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
import { createVerdictRecordStore, replaceVerdict, verdictRecord, type RecordedVerdict, type VerdictRecord } from "./verdict-record-store.js";
import type { CompletedReview } from "../code-review-runs.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_read_access";
const REPO = "acme/widgets";
const HEAD = "abc1230000000000000000000000000000000000";
const testSchema = `corbits_read_access_${randomBytes(6).toString("hex")}`;
const requested: string[] = [];
const reviewed: unknown[] = [];
type SentReview = { event: string; commit_id: string; body: string; comments: unknown[] };
const sentReviews: SentReview[] = [];
const FINISHED = {
  status: "completed" as const,
  headSha: HEAD,
  startedAt: "2026-10-17T00:00:00.000Z",
  summary: "Fixes the widget.",
  budgetExhausted: true,
  comments: [
    { path: "src/widget.ts", start: 1, end: 3, title: "Unchecked input", body: "Validate it first.", priority: 1, thread: { state: "not-tracked" as const }, open: true },
    { path: "src/other.ts", start: 5, end: 5, title: "Stale import", body: "Remove it.", priority: 3, thread: { state: "not-tracked" as const }, open: true },
  ],
};
let completed: CompletedReview | null = FINISHED;
let carriedTo: string | null = null;

const READS: Record<string, unknown> = {
  [`/repos/${REPO}/pulls`]: [
    { number: 8, title: "Fix the widget", draft: false, user: { login: "octocat" }, head: { sha: HEAD } },
    { number: 12, title: "Add the policy file", draft: false, user: { login: "triage[bot]", type: "Bot" }, head: { sha: HEAD } },
  ],
  [`/repos/${REPO}/pulls/8`]: {
    number: 8, title: "Fix the widget", state: "open",
    body: "Fixes #10, see https://github.com/acme/widgets/issues/11\n<!-- Closes #9 -->",
    body_html: "<p>Fixes <a href=\"https://github.com/acme/widgets/issues/10\">#10</a>, see <a href=\"https://github.com/acme/widgets/issues/11\">#11</a></p>\n", user: { login: "octocat" }, head: { sha: HEAD, ref: "fix" }, base: { sha: "base" }, mergeable: true, labels: [], assignees: [] },
  [`/repos/${REPO}/issues/9`]: { number: 9, title: "Hidden", state: "open", body: "", html_url: "https://github.com/acme/widgets/issues/9" },
  [`/repos/${REPO}/issues/10`]: { number: 10, title: "Shown", state: "open", body: "", html_url: "https://github.com/acme/widgets/issues/10" },
  [`/repos/${REPO}/issues/11`]: { number: 11, title: "Pasted", state: "open", body: "", html_url: "https://github.com/acme/widgets/issues/11" },
  [`/repos/${REPO}/pulls/8/commits`]: [{ sha: HEAD, commit: { message: "fix: the widget" } }],
  [`/repos/${REPO}/pulls/8/files`]: [{ filename: "src/widget.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+fixed" }],
  [`/repos/${REPO}/issues/8/comments`]: [],
  [`/repos/${REPO}/compare/base...older`]: { files: [{ filename: "src/widget.ts", status: "modified", patch: "@@ -1 +1 @@\n+fixed" }] },
  [`/repos/${REPO}/pulls/9`]: { number: 9, title: "Held by a ruleset", state: "open", user: { login: "octocat" }, head: { sha: HEAD, ref: "held" }, mergeable: true, mergeable_state: "blocked", labels: [], assignees: [] },
  [`/repos/${REPO}/pulls/9/commits`]: [],
  [`/repos/${REPO}/pulls/9/files`]: [],
  [`/repos/${REPO}/pulls/9/reviews`]: [],
  [`/repos/${REPO}/issues/9/comments`]: [],
  [`/repos/${REPO}/commits/${HEAD}/check-runs`]: { check_runs: [] },
  [`/repos/${REPO}/commits/${HEAD}/status`]: { statuses: [] },
};

async function github(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  requested.push(`${req.method} ${pathname}`);
  if (pathname === "/app/installations/1/access_tokens") return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  if (req.method === "GET" && pathname in READS) return Response.json(READS[pathname]);
  if (pathname === `/repos/${REPO}/installation`) return Response.json({ id: 1 });
  if (req.method === "POST" && pathname === "/graphql") return Response.json({ data: { repository: null } });
  if (req.method === "GET" && pathname === `/repos/${REPO}/pulls/8/reviews`) {
    return Response.json(sentReviews.map((review, index) => ({ id: 100 + index, user: { login: "triage[bot]" }, state: "COMMENTED", commit_id: review.commit_id, body: review.body })));
  }
  if (req.method === "GET" && /^\/repos\/[^/]+\/[^/]+\/pulls\/8\/reviews\/\d+\/comments$/.test(pathname)) return Response.json([]);
  if (req.method === "POST" && pathname === `/repos/${REPO}/pulls/8/reviews`) {
    const posted = await req.json() as SentReview;
    if (posted.event === "COMMENT") sentReviews.push(posted);
    else reviewed.push(posted);
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
  codeReviews: { async latest() { return { review: completed, completed, carriedTo }; } },
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
    { id: "prn_bb", tenantId: TENANT, kind: "user", refId: "usr_bb", status: "active" },
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
    { id: "grt_triage_approve", tenantId: TENANT, roleId: "rol_triage", resource: "triage-do:approve:*", action: "invoke", effect: "allow", origin: "role" },
    { id: "grt_bb_comment", tenantId: TENANT, principalId: "prn_bb", resource: "triage-do:comment:bitbucket-datacenter:proj/api", action: "invoke", effect: "allow", origin: "system" },
  ]);
  await db.insert(schema.provider).values({ id: "prv_github", tenantId: TENANT, name: "github", plugin: "http", apiBaseUrl: githubApiOrigin });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  await db.insert(schema.credential).values({
    id: "crd_github", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key",
    secret: await cipher.encrypt(JSON.stringify({ appId: "1", privateKey }), credentialAad("crd_github", "secret")), status: "active", metadata: { appSlug: "triage" },
  });
  await db.insert(schema.tenant).values([
    { id: "tnt_read_child", name: "Child", slug: "read-child", domain: "read-child.test", parentId: TENANT },
    { id: "tnt_read_unslugged", name: "Unslugged", slug: "read-unslugged", domain: "read-unslugged.test" },
  ]);
  await db.insert(schema.credential).values({
    id: "crd_unslugged", tenantId: "tnt_read_unslugged", principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key",
    secret: await cipher.encrypt(JSON.stringify({ appId: "1", privateKey }), credentialAad("crd_unslugged", "secret")), status: "active",
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
    expect(await pulls.json()).toMatchObject({ repos: [{ repo: REPO, prs: [{ number: 8 }, { number: 12, byTriage: true }] }, { repo: "PROJ/api", source: "bitbucket-datacenter", prs: [] }] });

    const details = await prDetails(new Request(`http://hub.test/pull?repo=${REPO}&number=8`), member(user));
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({ pr: { number: 8 }, files: [{ path: "src/widget.ts" }] });
  }

  const act = await prActions({ action: "merge", repo: REPO, number: 8 }, member("usr_member"));
  expect(act.status).toBe(403);
  expect(await act.json()).toEqual({ error: { code: "forbidden", message: "You do not have access to the GitHub App credential." } });
  expect(requested.some((line) => line.startsWith("PUT"))).toBe(false);
}, 60_000);

test("PostgreSQL: the listing marks the App's own pull request through an inherited credential, and lists unmarked when the App has no slug", async () => {
  const record = { name: REPO, connected: true, enabled: true, installationId: 1 };
  const own = (prs: Array<{ number: number; byTriage?: true }>) => prs.map((pr) => [pr.number, pr.byTriage === true]);
  expect(own(await list("tnt_read_child")(record))).toEqual([[8, false], [12, true]]);
  expect(own(await list("tnt_read_unslugged")(record))).toEqual([[8, false], [12, false]]);
});

test("PostgreSQL: pull request details ask GitHub for the review decision only when the merge is blocked", async () => {
  requested.length = 0;
  await prDetails(new Request(`http://hub.test/pull?repo=${REPO}&number=8`), member("usr_member"));
  expect(requested).not.toContain("POST /graphql");
  await prDetails(new Request(`http://hub.test/pull?repo=${REPO}&number=9`), member("usr_member"));
  expect(requested).toContain("POST /graphql");
});

test("PostgreSQL: a review decision GitHub does not give leaves it unknown and still serves the details", async () => {
  const blocked = await prDetails(new Request(`http://hub.test/pull?repo=${REPO}&number=9`), member("usr_member"));
  expect(blocked.status).toBe(200);
  expect(await blocked.json()).toMatchObject({ pr: { number: 9, mergeableState: "blocked", reviewDecision: null } });
});

test("PostgreSQL: pull request details find referenced issues only in the description GitHub shows, a pasted issue URL included", async () => {
  const details = await (await prDetails(new Request(`http://hub.test/pull?repo=${REPO}&number=8`), member("usr_member"))).json() as { issues: Array<{ number: number }> };
  expect(details.issues.map((issue) => issue.number)).toEqual([10, 11]);
});

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

test("PostgreSQL: a code review is sent once per head as one COMMENT review, inline where the diff shows the lines and in the body elsewhere, and at the head it was carried over to unless already sent on its own", async () => {
  const send = { action: "code-review", repo: REPO, number: 8, headSha: HEAD } as const;
  expect((await prActions(send, member("usr_user"))).status).toBe(403);
  expect(sentReviews).toEqual([]);

  const first = await prActions(send, member("usr_approver"));
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ reviewId: 1, sent: true });
  expect(sentReviews).toEqual([{
    commit_id: HEAD,
    event: "COMMENT",
    body: "Fixes the widget.\n\nStopped early: the reviewer reached its limit for reading the repository.\n\nThis review did not read the whole change; approve and merge are held until a review does.\n\n**P3 · Stale import** · `src/other.ts:5`\n\nRemove it.\n\n<!-- corbits-code-review -->",
    comments: [{ path: "src/widget.ts", line: 1, side: "RIGHT", body: "**P1 · Unchecked input**\n\nValidate it first.\n\nAlso lines 2–3." }],
  }]);

  const again = await prActions(send, member("usr_approver"));
  expect(await again.json()).toEqual({ reviewId: 100, sent: false });
  expect(sentReviews).toHaveLength(1);

  const details = await (await prDetails(new Request(`http://hub.test/pull?repo=${REPO}&number=8`), member("usr_approver"))).json() as { reviews: unknown[] };
  expect(details.reviews).toEqual([expect.objectContaining({ commitId: HEAD, codeReview: true })]);

  const outdated = await prActions({ ...send, headSha: "older" }, member("usr_approver"));
  expect(outdated.status).toBe(409);
  expect(await outdated.json()).toMatchObject({ error: { code: "code_review_outdated" } });

  completed = { ...FINISHED, headSha: "newer", summary: "", comments: [], budgetExhausted: false, complete: true };
  expect(await (await prActions({ ...send, headSha: "newer" }, member("usr_approver"))).json()).toMatchObject({ error: { code: "code_review_empty" } });
  completed = null;
  expect(await (await prActions(send, member("usr_approver"))).json()).toMatchObject({ error: { code: "no_code_review" } });
  expect(sentReviews).toHaveLength(1);

  sentReviews.length = 0;
  completed = { ...FINISHED, headSha: "older" };
  carriedTo = HEAD;
  expect(await (await prActions(send, member("usr_approver"))).json()).toEqual({ reviewId: 1, sent: true });
  expect(sentReviews.map((review) => review.commit_id)).toEqual([HEAD]);

  // Sent on the head it was made for, it stays on the same lines, so the head it was carried over to gets no second copy.
  sentReviews.length = 0;
  sentReviews.push({ event: "COMMENT", commit_id: "older", body: "Fixes the widget.\n\n<!-- corbits-code-review -->", comments: [] });
  expect(await (await prActions(send, member("usr_approver"))).json()).toEqual({ reviewId: 100, sent: false });
  expect(sentReviews).toHaveLength(1);
});

test("PostgreSQL: every verdict route needs workflow-run read, which holding the GitHub credential does not give", async () => {
  const unused = {} as never;
  const app = guardedApp(handle.db, sessionOf, grants, {
    triageVerdicts: createTriageVerdicts({ ...deps, list, verdicts: unused, managerRuns: unused, openPulls: unused, triageState: unused, now: unused }),
    triageTimeline: createTriageTimeline({ verdicts: unused }),
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

test("PostgreSQL: a held Do approved while the listener is starting answers 202, and its head is queued for the reconciler to mail once the listener is up", async () => {
  const target = { labels: ["api"] };
  const tag = { list: "pass" as const, index: 0, kind: "labels" as const, target, held: true, effectId: doEffectId({ repo: REPO, number: 8, headSha: HEAD, list: "pass", index: 0, kind: "labels", target }) };
  const verdict = { repo: REPO, number: 8, headSha: HEAD, request: { repo: REPO, number: 8, labels: [], owned: [], comment: "" }, actions: [tag] };
  const events = [{ seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "evaluate", output: { ref: `inline:${JSON.stringify(verdict)}` } } }];
  let kicked = 0;
  const store = triageRows();
  const heldDos = createGithubHeldDos({
    ...deps,
    ...NOT_HELD,
    store,
    retry() {
      kicked += 1;
    },
    runReader: { async readRunEvents() { return events; } },
    verdicts: { async forPull() { return [{ runId: "wfr_gap", degraded: null, runStatus: "completed" }] as VerdictRecord[]; }, async forHostedPull() { return [{ runId: "wfr_gap", degraded: null, runStatus: "completed" }] as VerdictRecord[]; } },
    async toListener() {
      throw new ListenerUnroutedError("github", "wfr_listener@tenant.example");
    },
    async passRequest() {
      return undefined;
    },
    log() {},
  });
  await handle.db.insert(schema.workflowDefinition).values({ id: "wfd_gap", tenantId: TENANT, name: "pr-triage", status: "stopped" });
  await handle.db.insert(schema.workflowRun).values({ id: "wfr_gap", definitionId: "wfd_gap", anchorRunId: "wfr_gap", tenantId: TENANT, status: "completed" });
  const res = await heldDos({ runId: "wfr_gap", repo: REPO, number: 8, effectId: tag.effectId, kind: "labels" }, member("usr_approver"));
  expect({ status: res.status, body: await res.json() }).toEqual({ status: 202, body: { status: "sent" } });
  expect(kicked).toBe(1);
  expect(store.rows.map((row) => `${row.number}:${row.headSha}:${row.status}:${row.unrouted === true}`)).toEqual([`8:${HEAD}:failed:true`]);
});

test("PostgreSQL: a held Do of a verdict a manager reported is approved from the recorded verdict and the mirror request its pass kept, and goes to the listener; once the run's newer verdict replaced it, it is superseded", async () => {
  await handle.db.insert(schema.workflowDefinition).values({ id: "wfd_manager", tenantId: TENANT, name: "triage-manager-github", status: "stopped" });
  await handle.db.insert(schema.workflowRun).values({ id: "wfr_manager", definitionId: "wfd_manager", anchorRunId: "wfr_manager", tenantId: TENANT, status: "running" });
  const target = { labels: ["api"] };
  const tag = { list: "pass" as const, index: 0, kind: "labels" as const, target, held: true, effectId: doEffectId({ repo: REPO, number: 8, headSha: HEAD, list: "pass", index: 0, kind: "labels", target }) };
  const request = { repo: REPO, number: 8, labels: ["Triage: Pass"], owned: [], comment: "Ready for review." };
  const recorded: Array<Pick<VerdictRecord, "runId" | "headSha" | "degraded" | "runStatus" | "detail">> = [{ runId: "wfr_manager", headSha: HEAD, degraded: null, runStatus: "completed", detail: { headSha: HEAD, actions: [tag] } }];
  const kept: unknown[] = [];
  const listened: unknown[] = [];
  const heldDos = createGithubHeldDos({
    ...deps,
    ...NOT_HELD,
    runReader: { async readRunEvents() { return [{ seq: 0, type: "RunStarted", body: { type: "RunStarted", seq: 0 } }]; } },
    verdicts: { async forPull() { return recorded as VerdictRecord[]; }, async forHostedPull() { return recorded as VerdictRecord[]; } },
    async toListener(_tenantId, payload) {
      listened.push(payload);
      return true;
    },
    async passRequest(_tenantId, pr, runId, head) {
      kept.push({ pr, runId, head });
      return request;
    },
    log() {},
  });
  const res = await heldDos({ runId: "wfr_manager", repo: REPO, number: 8, effectId: tag.effectId, kind: "labels" }, member("usr_approver"));
  expect({ status: res.status, body: await res.json() }).toEqual({ status: 202, body: { status: "sent" } });
  expect(kept).toEqual([{ pr: { source: "github", repo: REPO, number: 8 }, runId: "wfr_manager", head: HEAD }]);
  expect(listened).toEqual([{ kind: "approve-do", runId: "wfr_manager", principalId: "prn_approver", list: "pass", index: 0, request, step: { effectId: tag.effectId, headSha: HEAD, kind: "labels", target } }]);

  recorded[0] = { ...recorded[0]!, headSha: "newer", detail: { headSha: "newer", actions: [] } };
  const replaced = await heldDos({ runId: "wfr_manager", repo: REPO, number: 8, effectId: tag.effectId, kind: "labels" }, member("usr_approver"));
  expect({ status: replaced.status, body: await replaced.json() }).toMatchObject({ status: 409, body: { error: { code: "verdict_superseded" } } });
  expect(listened).toHaveLength(1);
});

test("PostgreSQL: approving a held Do on Bitbucket checks that host's grant and mails its source, and a post without a source still checks GitHub", async () => {
  const bb = "PROJ/api";
  const target = { body: "Please split this." };
  const comment = { list: "pass" as const, index: 0, kind: "comment" as const, target, held: true, effectId: doEffectId({ repo: bb, number: 1, headSha: HEAD, list: "pass", index: 0, kind: "comment", target }) };
  const verdict = { repo: bb, number: 1, headSha: HEAD, request: { repo: bb, number: 1, labels: [], owned: [], comment: "" }, actions: [comment] };
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
  await handle.db.insert(schema.workflowDefinition).values({ id: "wfd_bb", tenantId: TENANT, name: "pr-triage-bb", status: "stopped" });
  await handle.db.insert(schema.workflowRun).values({ id: "wfr_bb", definitionId: "wfd_bb", anchorRunId: "wfr_bb", tenantId: TENANT, status: "completed" });
  const body = { runId: "wfr_bb", repo: bb, number: 1, effectId: comment.effectId, kind: "comment" as const };

  const sent = await heldDos({ ...body, source: "bitbucket-datacenter" }, member("usr_bb"));
  expect({ status: sent.status, body: await sent.json() }).toEqual({ status: 202, body: { status: "sent" } });
  expect(mailed).toEqual([expect.objectContaining({ repoSource: "bitbucket-datacenter" })]);

  const github = await heldDos(body, member("usr_bb"));
  expect({ status: github.status, body: await github.json() }).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  expect(mailed).toHaveLength(1);
});

test("PostgreSQL: a later completed verdict on the other host does not supersede a held Do, and one on the same host does", async () => {
  const target = { labels: ["api"] };
  const tag = { list: "pass" as const, index: 0, kind: "labels" as const, target, held: true, effectId: doEffectId({ repo: REPO, number: 8, headSha: HEAD, list: "pass", index: 0, kind: "labels", target }) };
  const verdict = { repo: REPO, number: 8, headSha: HEAD, request: { repo: REPO, number: 8, labels: [], owned: [], comment: "" }, actions: [tag] };
  const events = [{ seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "evaluate", output: { ref: `inline:${JSON.stringify(verdict)}` } } }];
  const mailed: unknown[] = [];
  await migrateTriageTables(handle.db, testSchema);
  const heldDos = createGithubHeldDos({
    ...deps,
    ...NOT_HELD,
    runReader: { async readRunEvents() { return events; } },
    verdicts: createVerdictRecordStore(handle.db),
    async toListener(_tenantId, payload) {
      mailed.push(payload);
      return true;
    },
    async passRequest() { throw new Error("pr-triage's verdict is in its run's log"); },
    log() {},
  });
  await handle.db.insert(schema.workflowDefinition).values([
    { id: "wfd_host_gh", tenantId: TENANT, name: "pr-triage", status: "stopped" },
    { id: "wfd_host_bb", tenantId: TENANT, name: "pr-triage-bitbucket-datacenter", status: "stopped" },
  ]);
  await handle.db.insert(schema.workflowRun).values([
    { id: "wfr_host_gh", definitionId: "wfd_host_gh", anchorRunId: "wfr_host_gh", tenantId: TENANT, status: "completed" },
    { id: "wfr_host_bb", definitionId: "wfd_host_bb", anchorRunId: "wfr_host_bb", tenantId: TENANT, status: "completed" },
  ]);
  function row(runId: string, at: string): RecordedVerdict {
    return {
      runId, repo: REPO, number: 8, headSha: HEAD, startedAt: new Date(at), verdictAt: new Date(at), settled: true,
      state: "ready", actor: "author", humanGated: false, degraded: null, checks: [], dos: [], commented: false, runStatus: "completed",
    };
  }
  // The interchange schema drop does not remove these rows, and a run that is gone is read as GitHub.
  const planted = ["wfr_host_gh", "wfr_host_bb", "wfr_host_gh_later"];
  try {
    await replaceVerdict(handle.db, TENANT, row("wfr_host_gh", "2026-10-01T00:00:00Z"));
    await replaceVerdict(handle.db, TENANT, row("wfr_host_bb", "2026-10-02T00:00:00Z"));

    const sent = await heldDos({ runId: "wfr_host_gh", repo: REPO, number: 8, effectId: tag.effectId, kind: "labels" }, member("usr_approver"));
    expect({ status: sent.status, body: await sent.json(), mailed }).toEqual({ status: 202, body: { status: "sent" }, mailed: [expect.anything()] });

    await replaceVerdict(handle.db, TENANT, row("wfr_host_gh_later", "2026-10-03T00:00:00Z"));
    const replaced = await heldDos({ runId: "wfr_host_gh", repo: REPO, number: 8, effectId: tag.effectId, kind: "labels" }, member("usr_approver"));
    expect({ status: replaced.status, body: await replaced.json() }).toMatchObject({ status: 409, body: { error: { code: "verdict_superseded" } } });
    expect(mailed).toHaveLength(1);
  } finally {
    await handle.db.delete(verdictRecord).where(and(eq(verdictRecord.tenantId, TENANT), inArray(verdictRecord.runId, planted)));
  }
});
