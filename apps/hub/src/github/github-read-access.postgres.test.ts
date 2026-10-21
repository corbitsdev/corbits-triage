// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { authorize } from "@intx/authz";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createGrantStore, dropSchema, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { emptyPack, TRIAGE_ROLE, type ActionKind } from "@corbits/triage-contracts";
import { doEffectId } from "@corbits/triage-workflows/logic/actions";
import { guardedApp } from "../integrations/test-app.js";
import { createAuditLog } from "../audit-log.js";
import { createGithubHeldDos } from "./held-dos.js";
import { createGithubOpenPulls, createOpenPullsCache } from "./open-pulls.js";
import { createTenantOpenPrs } from "./tenant-open-heads.js";
import { createGithubPrActions } from "./pr-actions.js";
import { createGithubPrDetails } from "./pr-details.js";
import { createGithubPrPreview, PreviewBody } from "./pr-preview.js";
import { createTriageStats } from "./triage-stats.js";
import { createTriageTimeline } from "./triage-timeline.js";
import { createTriageVerdicts } from "./triage-verdicts.js";
import type { VerdictRecord } from "./verdict-record-store.js";
import type { CompletedReview } from "../code-review-runs.js";

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
    { path: "src/widget.ts", start: 1, end: 3, title: "Unchecked input", body: "Validate it first.", priority: 1 },
    { path: "src/other.ts", start: 5, end: 5, title: "Stale import", body: "Remove it." },
  ],
};
let completed: CompletedReview | null = FINISHED;
let carriedTo: string | null = null;

const READS: Record<string, unknown> = {
  [`/repos/${REPO}/pulls`]: [{ number: 8, title: "Fix the widget", draft: false, user: { login: "octocat" }, head: { sha: HEAD } }],
  [`/repos/${REPO}/pulls/8`]: {
    number: 8, title: "Fix the widget", state: "open",
    body: "Fixes #10, see https://github.com/acme/widgets/issues/11\n<!-- Closes #9 -->",
    body_html: "<p>Fixes <a href=\"https://github.com/acme/widgets/issues/10\">#10</a>, see <a href=\"https://github.com/acme/widgets/issues/11\">#11</a></p>\n", user: { login: "octocat" }, head: { sha: HEAD, ref: "fix" }, mergeable: true, labels: [], assignees: [] },
  [`/repos/${REPO}/issues/9`]: { number: 9, title: "Hidden", state: "open", body: "", html_url: "https://github.com/acme/widgets/issues/9" },
  [`/repos/${REPO}/issues/10`]: { number: 10, title: "Shown", state: "open", body: "", html_url: "https://github.com/acme/widgets/issues/10" },
  [`/repos/${REPO}/issues/11`]: { number: 11, title: "Pasted", state: "open", body: "", html_url: "https://github.com/acme/widgets/issues/11" },
  [`/repos/${REPO}/pulls/8/commits`]: [{ sha: HEAD, commit: { message: "fix: the widget" } }],
  [`/repos/${REPO}/pulls/8/files`]: [{ filename: "src/widget.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+fixed" }],
  [`/repos/${REPO}/issues/8/comments`]: [],
  [`/repos/${REPO}/pulls/9`]: { number: 9, title: "Held by a ruleset", state: "open", user: { login: "octocat" }, head: { sha: HEAD, ref: "held" }, mergeable: true, mergeable_state: "blocked", labels: [], assignees: [] },
  [`/repos/${REPO}/pulls/9/commits`]: [],
  [`/repos/${REPO}/pulls/9/files`]: [],
  [`/repos/${REPO}/pulls/9/reviews`]: [],
  [`/repos/${REPO}/issues/9/comments`]: [],
  [`/repos/${REPO}/commits/${HEAD}/check-runs`]: { check_runs: [] },
  [`/repos/${REPO}/commits/${HEAD}/status`]: { statuses: [] },
  "/orgs/acme/teams/secret/memberships/octocat": { state: "active" },
};

async function github(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  requested.push(`${req.method} ${pathname}`);
  if (pathname === "/app/installations/1/access_tokens") return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  if (req.method === "GET" && pathname in READS) return Response.json(READS[pathname]);
  if (pathname === `/repos/${REPO}/installation`) return Response.json({ id: 1 });
  if (pathname === "/app") return Response.json({ slug: "triage" });
  if (req.method === "POST" && pathname === "/graphql") return Response.json({ data: { repository: null } });
  if (req.method === "GET" && pathname === `/repos/${REPO}/pulls/8/reviews`) {
    return Response.json(sentReviews.map((review, index) => ({ id: 100 + index, user: { login: "triage[bot]" }, state: "COMMENTED", commit_id: review.commit_id, body: review.body })));
  }
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
  return (await authorize(grants, principalId, tenantId, resource, action)).effect === "allow";
}

const deps = { db: handle.db, cipher, authorize: authorizePortal, githubApiOrigin };
const list = createTenantOpenPrs({ ...deps, tenantBitbucket: async () => undefined });
const openPulls = createGithubOpenPulls({ ...deps, list, cache: createOpenPullsCache(() => new Date()) });
const prDetails = createGithubPrDetails({ ...deps, tenantBitbucket: async () => undefined, log() {} });
const prActions = createGithubPrActions({
  ...deps,
  log() {},
  async readCheckPack() { return { status: "missing" } as const; },
  codeReviews: { async latest() { return { review: completed, completed, carriedTo }; } },
});
const prPreview = createGithubPrPreview({ ...deps, async readCheckPack() { return { status: "ok", pack: emptyPack(REPO), automatic: [], source: { repo: { id: "art_pack", version: 1 } } } as const; } });

function member(user: string) {
  return { tenantId: TENANT, principalId: user.replace("usr_", "prn_") };
}

function probe() {
  const pack = emptyPack(REPO);
  pack.actions.pass = [{ do: "comment", target: { body: "Thanks" }, when: { author: [{ team: "secret" }] } }];
  return PreviewBody.assert({ repo: REPO, number: 8, pack });
}

async function probeResult(res: Response): Promise<string | undefined> {
  const body = await res.json() as { actions: { dos?: Array<{ reason: string; skipped?: true }> } };
  const step = body.actions.dos?.[0];
  return step && (step.skipped ? step.reason : "runs");
}

beforeAll(async () => {
  await runMigrations(TEST_DB, { schema: testSchema });
  const db = handle.db;
  await db.insert(schema.tenant).values({
    id: TENANT, name: "Read access", slug: "read-access", domain: "read-access.test",
    config: { corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true, installationId: 1 }, { name: "acme/other", connected: false }] } },
  });
  await db.insert(schema.principal).values([
    { id: "prn_member", tenantId: TENANT, kind: "user", refId: "usr_member", status: "active" },
    { id: "prn_user", tenantId: TENANT, kind: "user", refId: "usr_user", status: "active" },
    { id: "prn_admin", tenantId: TENANT, kind: "user", refId: "usr_admin", status: "active" },
    { id: "prn_approver", tenantId: TENANT, kind: "user", refId: "usr_approver", status: "active" },
    { id: "prn_lent", tenantId: TENANT, kind: "user", refId: "usr_lent", status: "active" },
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
    { id: "grt_approver_labels", tenantId: TENANT, principalId: "prn_approver", resource: `triage-do:labels:${REPO}`, action: "invoke", effect: "allow", origin: "system" },
    { id: "grt_approver_comment", tenantId: TENANT, principalId: "prn_approver", resource: `triage-do:comment:${REPO}`, action: "invoke", effect: "allow", origin: "system" },
    { id: "grt_lent_use", tenantId: TENANT, principalId: "prn_lent", resource: "credential:crd_github", action: "use", effect: "allow", origin: "system" },
    { id: "grt_triage_approve", tenantId: TENANT, roleId: "rol_triage", resource: "triage-do:approve:*", action: "invoke", effect: "allow", origin: "role" },
  ]);
  await db.insert(schema.provider).values({ id: "prv_github", tenantId: TENANT, name: "github", plugin: "http", apiBaseUrl: githubApiOrigin });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  await db.insert(schema.credential).values({
    id: "crd_github", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key",
    secret: await cipher.encrypt(JSON.stringify({ appId: "1", privateKey }), credentialAad("crd_github", "secret")), status: "active",
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
    expect(await pulls.json()).toMatchObject({ repos: [{ repo: REPO, prs: [{ number: 8 }] }] });

    const details = await prDetails(new Request(`http://hub.test/pull?repo=${REPO}&number=8`), member(user));
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({ pr: { number: 8 }, files: [{ path: "src/widget.ts" }] });

    const preview = await prPreview({ repo: REPO, number: 8 }, member(user), AbortSignal.timeout(30_000));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ repo: REPO, number: 8, headSha: HEAD, pack: "saved" });
  }

  const act = await prActions({ action: "merge", repo: REPO, number: 8 }, member("usr_member"));
  expect(act.status).toBe(403);
  expect(await act.json()).toEqual({ error: { code: "forbidden", message: "You do not have access to the GitHub App credential." } });
  expect(requested.some((line) => line.startsWith("PUT"))).toBe(false);
}, 60_000);

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

test("PostgreSQL: only a member who may manage the workspace reads the teams a candidate pack's steps are for, so a reader cannot probe team membership", async () => {
  const membership = "GET /orgs/acme/teams/secret/memberships/octocat";
  requested.length = 0;
  const reader = await prPreview(probe(), member("usr_member"), AbortSignal.timeout(30_000));
  expect(reader.status).toBe(200);
  expect(requested).not.toContain(membership);
  expect(await probeResult(reader)).toBe("Not run: it is not known whether the author is secret.");

  const admin = await prPreview(probe(), member("usr_admin"), AbortSignal.timeout(30_000));
  expect(admin.status).toBe(200);
  expect(requested).toContain(membership);
  expect(await probeResult(admin)).toBe("runs");
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
    body: "Fixes the widget.\n\nStopped early: the reviewer reached its limit for reading the repository.\n\n**Stale import** · `src/other.ts:5`\n\nRemove it.\n\n<!-- corbits-code-review -->",
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

  completed = { ...FINISHED, headSha: "newer", summary: "", comments: [], budgetExhausted: false };
  expect(await (await prActions({ ...send, headSha: "newer" }, member("usr_approver"))).json()).toMatchObject({ error: { code: "code_review_empty" } });
  completed = null;
  expect(await (await prActions(send, member("usr_approver"))).json()).toMatchObject({ error: { code: "no_code_review" } });
  expect(sentReviews).toHaveLength(1);

  sentReviews.length = 0;
  completed = { ...FINISHED, comments: [], budgetExhausted: false, cut: { lines: 6, of: 40, unread: ["src/b.ts", "src/`c`.ts", "@team\n**x**.md"] } };
  expect(await (await prActions(send, member("usr_approver"))).json()).toEqual({ reviewId: 1, sent: true });
  expect(sentReviews.map((review) => review.body)).toEqual(["Fixes the widget.\n\nNot reviewed in full: 3 files, over the size limit.\n- `src/b.ts`\n- ``src/`c`.ts``\n- `@team **x**.md`\n\n<!-- corbits-code-review -->"]);

  sentReviews.length = 0;
  completed = { ...FINISHED, summary: "", comments: [], budgetExhausted: false, cut: { lines: 6, of: 40 } };
  expect(await (await prActions(send, member("usr_approver"))).json()).toEqual({ reviewId: 1, sent: true });
  expect(sentReviews.map((review) => review.body)).toEqual(["Some files were not reviewed: the diff was over the size limit.\n\n<!-- corbits-code-review -->"]);

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
    triageVerdicts: createTriageVerdicts({ ...deps, list, verdicts: unused, observer: unused, ready: unused, versions: unused, openPulls: unused, triageState: unused, now: unused }),
    triageTimeline: createTriageTimeline({ verdicts: unused }),
    triageStats: createTriageStats({ verdicts: unused, outcomes: unused, now: unused, log: unused }),
    audit: createAuditLog({ db: unused, artifacts: unused, readCheckPack: unused, runReader: unused, sameSource: unused, authorize: unused, workflows: ["pr-triage"] }),
  });
  for (const route of ["triage-verdicts", "triage-timeline", "triage-stats", "audit"]) {
    const res = await app.request(`/api/integrations/${route}/${TENANT}?repo=${REPO}&number=8`, { headers: { "x-test-user": "usr_user" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
  }
});

test("PostgreSQL: approving a held Do needs its kind's grant and mails pr-triage who approved it; it stands only on the newest judged verdict; a written or unrunnable Do is refused", async () => {
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
  const mailed: Array<{ address: string; payload: unknown }> = [];
  let recorded: Array<Pick<VerdictRecord, "runId" | "degraded" | "runStatus">> = [];
  const heldDos = createGithubHeldDos({
    ...deps,
    runReader: { async readRunEvents() { return events; } },
    verdicts: { async forPull() { return recorded as VerdictRecord[]; } },
    async liveDeployments() { return [{ runId: "wfr_anchor", address: "wfr_anchor@read-access.test", createdAt: new Date(), cancelling: false }]; },
    async deliver(_tenantId, address, payload) { mailed.push({ address, payload }); },
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
    address: "wfr_anchor@read-access.test",
    payload: {
      kind: "approve-do", runId: "wfr_verdict", principalId: "prn_approver", list: "pass", index: 1,
      request: verdict.request, step: { effectId: tag.effectId, headSha: HEAD, kind: "labels", target: { labels: ["api"] } },
    },
  }]);

  recorded = [{ runId: "wfr_verdict", degraded: null, runStatus: "completed" }, { runId: "wfr_degraded", degraded: "error", runStatus: "completed" }, { runId: "wfr_failed", degraded: null, runStatus: "failed" }];
  expect((await approve("usr_approver", ship)).status).toBe(202);
  recorded.push({ runId: "wfr_newer", degraded: null, runStatus: "completed" });
  expect(await approve("usr_approver", ship)).toMatchObject({ status: 409, body: { error: { code: "verdict_superseded" } } });
  expect(mailed).toHaveLength(2);
});
