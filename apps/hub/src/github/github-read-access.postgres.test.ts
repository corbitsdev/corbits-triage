// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { authorize } from "@intx/authz";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createGrantStore, dropSchema, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { emptyPack } from "@corbits/triage-contracts";
import { createGithubOpenPulls, createOpenPullsCache } from "./open-pulls.js";
import { createGithubPrActions } from "./pr-actions.js";
import { createGithubPrDetails } from "./pr-details.js";
import { createGithubPrDos } from "./pr-dos.js";
import { createGithubPrPreview } from "./pr-preview.js";
import { createTriageStats } from "./triage-stats.js";
import { createTriageTimeline } from "./triage-timeline.js";
import { createTriageVerdicts } from "./triage-verdicts.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_read_access";
const PORTAL = "https://portal.example";
const REPO = "acme/widgets";
const HEAD = "abc123";
const testSchema = `corbits_read_access_${randomBytes(6).toString("hex")}`;
const requested: string[] = [];
const reviewed: unknown[] = [];

const READS: Record<string, unknown> = {
  [`/repos/${REPO}/pulls`]: [{ number: 8, title: "Fix the widget", draft: false, user: { login: "octocat" }, head: { sha: HEAD } }],
  [`/repos/${REPO}/pulls/8`]: { number: 8, title: "Fix the widget", state: "open", user: { login: "octocat" }, head: { sha: HEAD, ref: "fix" }, mergeable: true, labels: [], assignees: [] },
  [`/repos/${REPO}/pulls/8/reviews`]: [],
  [`/repos/${REPO}/pulls/8/commits`]: [{ sha: HEAD, commit: { message: "fix: the widget" } }],
  [`/repos/${REPO}/pulls/8/files`]: [{ filename: "src/widget.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+fixed" }],
  [`/repos/${REPO}/issues/8/comments`]: [],
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
  return { user: { id: headers.get("x-test-user")! }, session: { id: "ses" } };
}

async function authorizePortal(principalId: string, tenantId: string, resource: string, action: string): Promise<boolean> {
  return (await authorize(grants, principalId, tenantId, resource, action)).effect === "allow";
}

const deps = { db: handle.db, cipher, getSession: sessionOf, authorize: authorizePortal, trustedPortalOrigins: [PORTAL], githubApiOrigin };
const openPulls = createGithubOpenPulls({ ...deps, cache: createOpenPullsCache(() => new Date()) });
const prDetails = createGithubPrDetails(deps);
const prActions = createGithubPrActions(deps);
const prPreview = createGithubPrPreview({ ...deps, async readCheckPack() { return { status: "ok", pack: emptyPack(REPO) } as const; } });

function get(user: string, path: string): Request {
  return new Request(`${PORTAL}${path}`, { headers: { "x-test-user": user, "sec-fetch-site": "same-origin" } });
}

function post(user: string, path: string, body: unknown): Request {
  return new Request(`${PORTAL}${path}`, {
    method: "POST",
    headers: { "x-test-user": user, "content-type": "application/json", origin: PORTAL, "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

/** A candidate pack gated on the author being in role `probe`, and roles that put team `secret` in it. */
function probe() {
  const pack = emptyPack(REPO);
  pack.custom = [{ id: "custom-1", name: "Probe", group: "pull-request", kind: "rule", rule: "author", who: "role", role: "probe" }];
  return { repo: REPO, number: 8, pack, roles: { probe: { teams: ["secret"] } } };
}

async function probeResult(res: Response): Promise<string | undefined> {
  const body = await res.json() as { checks: Array<{ check: string; result: string }> };
  return body.checks.find((check) => check.check === "custom-1")?.result;
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
  ]);
  await db.insert(schema.role).values([
    { id: "rol_member", tenantId: TENANT, name: "member", isSystem: true },
    { id: "rol_admin", tenantId: TENANT, name: "admin", isSystem: true },
  ]);
  await db.insert(schema.principalRole).values([{ principalId: "prn_member", roleId: "rol_member" }, { principalId: "prn_admin", roleId: "rol_admin" }]);
  await db.insert(schema.grant).values([
    { id: "grt_member_read", tenantId: TENANT, roleId: "rol_member", resource: "*", action: "read", effect: "allow", origin: "system" },
    { id: "grt_admin_read", tenantId: TENANT, roleId: "rol_admin", resource: "*", action: "read", effect: "allow", origin: "system" },
    { id: "grt_admin_manage", tenantId: TENANT, roleId: "rol_admin", resource: "*", action: "manage", effect: "allow", origin: "system" },
    { id: "grt_user_use", tenantId: TENANT, principalId: "prn_user", resource: "credential:crd_github", action: "use", effect: "allow", origin: "system" },
    { id: "grt_approver_use", tenantId: TENANT, principalId: "prn_approver", resource: "credential:crd_github", action: "use", effect: "allow", origin: "system" },
    { id: "grt_approver_approve", tenantId: TENANT, principalId: "prn_approver", resource: "github-review:*", action: "approve", effect: "allow", origin: "system" },
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
    const pulls = await openPulls(get(user, "/pulls"), TENANT);
    expect(pulls.status).toBe(200);
    expect(await pulls.json()).toMatchObject({ repos: [{ repo: REPO, prs: [{ number: 8 }] }] });

    const details = await prDetails(get(user, `/pull?repo=${REPO}&number=8`), TENANT);
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({ pr: { number: 8 }, files: [{ path: "src/widget.ts" }] });

    const preview = await prPreview(post(user, "/preview", { repo: REPO, number: 8 }), TENANT);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ repo: REPO, number: 8, headSha: HEAD, pack: "saved" });
  }

  const act = await prActions(post("usr_member", "/actions", { action: "merge", repo: REPO, number: 8 }), TENANT);
  expect(act.status).toBe(403);
  expect(await act.json()).toEqual({ error: { code: "forbidden", message: "You do not have access to the GitHub App credential." } });
  expect(requested.some((line) => line.startsWith("PUT"))).toBe(false);
}, 60_000);

test("PostgreSQL: pull request details serve only repositories connected to the workspace", async () => {
  const res = await prDetails(get("usr_member", "/pull?repo=acme/other&number=8"), TENANT);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "repo_not_connected" } });
});

test("PostgreSQL: only a member who may save roles previews candidate roles, so a reader cannot probe team membership", async () => {
  const membership = "GET /orgs/acme/teams/secret/memberships/octocat";
  requested.length = 0;
  const reader = await prPreview(post("usr_member", "/preview", probe()), TENANT);
  expect(reader.status).toBe(200);
  expect(requested).not.toContain(membership);
  expect(await probeResult(reader)).toBe("unconfirmed");

  const admin = await prPreview(post("usr_admin", "/preview", probe()), TENANT);
  expect(admin.status).toBe(200);
  expect(requested).toContain(membership);
  expect(await probeResult(admin)).toBe("pass");
});

test("PostgreSQL: approving needs the approve grant on top of use, and pins the review to the head shown", async () => {
  const approve = { action: "review", event: "APPROVE", repo: REPO, number: 8, body: "", headSha: HEAD };
  const refused = await prActions(post("usr_user", "/actions", approve), TENANT);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: { code: "forbidden", message: "You do not have the grant to approve pull requests in this repository." } });
  expect(reviewed).toEqual([]);

  const approved = await prActions(post("usr_approver", "/actions", approve), TENANT);
  expect(approved.status).toBe(200);
  expect(reviewed).toEqual([{ body: "", event: "APPROVE", commit_id: HEAD }]);
});

test("PostgreSQL: every verdict route needs workflow-run read, which holding the GitHub credential does not give", async () => {
  const unused = {} as never;
  const routes = [
    createTriageVerdicts({ ...deps, verdicts: unused, observer: unused, ready: unused, versions: unused, openPulls: unused, now: unused }),
    createTriageTimeline({ ...deps, verdicts: unused }),
    createTriageStats({ ...deps, verdicts: unused, dos: unused, now: unused }),
    createGithubPrDos({ ...deps, runReader: unused, store: unused, verdicts: unused, log: unused }).list,
  ];
  for (const route of routes) {
    const res = await route(get("usr_user", `/verdicts?repo=${REPO}&number=8`), TENANT);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "You do not have access to this workspace's triage runs." } });
  }
});
