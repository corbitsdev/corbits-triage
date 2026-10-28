// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { checkPolicyFile, type RepoSource } from "@corbits/triage-contracts";
import { PROVIDER, TOKEN_CREDENTIAL } from "../bitbucket-datacenter/names.js";
import { fileRefusal, readRepoPolicy } from "./repo-policy.js";
import { createPolicyFile, listedPolicyPull, PolicyPatchBody } from "./policy-file.js";
import { POLICY_BRANCH } from "./policy-pull.js";
import { POLICY_PUSH_MESSAGE } from "./policy-push.js";
import { createMemberOpenPulls, createOpenPullsCache } from "./open-pulls.js";
import { createRepoActivity } from "./repo-activity.js";
import { createTenantGithub, createTenantOpenPrs } from "./tenant-open-heads.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_policy_file";
const FROM_FILE = "acme/from-file";
const STARTER = "acme/starter";
const SHARED = "acme/shared";
const EXTENDS = "acme/extends";
const CHOSEN = "acme/chosen";
const CHOSEN_RACED = "acme/chosen-raced";
const PUSHED = "acme/pushed";
const BITBUCKET_PUSHED = "PROJ/pushed";
const PATCHED = "acme/patched";
const PATCH_LISTED = "acme/patch-listed";
const BOTH = "acme/both";
const UNHEARD = "acme/unheard";
const BITBUCKET_UNHEARD = "PROJ/unheard";
const MEMBER = { tenantId: TENANT, principalId: "prn_user" };
/** Uses the host credential, but may neither create grants nor manage the workspace. */
const USER = { tenantId: TENANT, principalId: "prn_plain" };
const FILE = `rules:
  - check: ci-green
    text: CI passes.
    reason: Required by branch protection.
    evidence: [maintainer-stated]
`;
const YML = ".corbits-triage.yml";
const YAML = ".corbits-triage.yaml";

/** Keyed by `repo@branch/path`. A null `text` is a file over 1 MB, whose content GitHub leaves out; the sha `DIRECTORY` is a directory at the path. */
const DIRECTORY = "directory";
const files = new Map<string, { sha: string; text: string | null }>();
let readFails = false;
/** Keyed by `repo:branch`, to the commit it points at. */
const refs = new Map<string, string>();
const pulls: Array<{ repo: string; number: number; head: string; base: string; title: string; body: string; open: boolean }> = [];
let commits = 0;
/** Each request GitHub got, as `METHOD path`. */
const requests: string[] = [];
/** Set, the next commit is followed by another caller opening this pull request first. */
let raced: (typeof pulls)[number] | undefined;
/** Each commit written through the contents API, with its message, as `repo:branch`. */
const branchCommits: Array<{ at: string; sha: string; message: string }> = [];
/** How many pull request edits fail next. */
let pullEditFailures = 0;
/** Set to a `repo@branch/path` key, the next read of it is followed by another commit to that file. */
let movedAfterRead: string | undefined;
/** Repositories whose default branch GitHub reports protected, and the ruleset rules each one's default branch has. */
const protectedBranches = new Set<string>();
const branchRules = new Map<string, Array<{ type: string }>>();
/** Bitbucket Data Center's branch permissions, by repository. */
const restrictions = new Map<string, unknown[]>();

function onMain(repo: string, path: string, text: string | null, sha = `blob${++commits}`): void {
  files.set(`${repo}@main/${path}`, { sha, text });
}

async function github(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (pathname === "/app/installations/1/access_tokens") return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  requests.push(`${req.method} ${pathname}`);
  const [, , owner, name, ...rest] = pathname.split("/");
  const repo = `${owner}/${name}`;
  const path = decodeURIComponent(rest.join("/"));
  if (req.method === "GET" && path.startsWith("contents/")) {
    if (readFails) return new Response(null, { status: 502 });
    const at = path.slice("contents/".length);
    const key = `${repo}@${url.searchParams.get("ref") ?? "main"}/${at}`;
    const file = files.get(key);
    if (!file) return new Response(null, { status: 404 });
    if (movedAfterRead === key) files.set(key, { sha: `blob${++commits}`, text: file.text });
    if (movedAfterRead === key) movedAfterRead = undefined;
    if (file.sha === DIRECTORY) return Response.json([{ type: "file", name: "inner.yaml" }]);
    const content = file.text === null ? { content: "", encoding: "none" } : { content: Buffer.from(file.text).toString("base64"), encoding: "base64" };
    return Response.json({ type: "file", sha: file.sha, ...content, html_url: `https://github.com/${repo}/blob/main/${at}` });
  }
  if (req.method === "PUT" && path.startsWith("contents/")) {
    const at = path.slice("contents/".length);
    const { branch, content, sha, message } = await req.json() as { branch: string; content: string; sha?: string; message: string };
    if (branch !== "main" && !refs.has(`${repo}:${branch}`)) return Response.json({ message: "Branch not found" }, { status: 404 });
    if (files.get(`${repo}@${branch}/${at}`)?.sha !== sha) return Response.json({ message: "sha does not match" }, { status: 409 });
    files.set(`${repo}@${branch}/${at}`, { sha: `blob${++commits}`, text: Buffer.from(content, "base64").toString("utf8") });
    branchCommits.push({ at: `${repo}:${branch}`, sha: `commit${commits}`, message });
    if (raced) pulls.push(raced);
    raced = undefined;
    return Response.json({ content: { sha: `blob${commits}` }, commit: { sha: `commit${commits}` } }, { status: 201 });
  }
  if (req.method === "GET" && path === "") return Response.json({ default_branch: "main" });
  if (req.method === "GET" && path === "branches/main") return Response.json({ name: "main", protected: protectedBranches.has(repo) });
  if (req.method === "GET" && path === "rules/branches/main") return Response.json(branchRules.get(repo) ?? []);
  if (req.method === "GET" && path === "git/ref/heads/main") return Response.json({ object: { sha: "main-sha" } });
  if (req.method === "POST" && path === "git/refs") {
    const { ref, sha } = await req.json() as { ref: string; sha: string };
    const branch = ref.slice("refs/heads/".length);
    if (refs.has(`${repo}:${branch}`)) return Response.json({ message: "Reference already exists" }, { status: 422 });
    refs.set(`${repo}:${branch}`, sha);
    for (const [key, file] of files) if (key.startsWith(`${repo}@main/`)) files.set(key.replace("@main/", `@${branch}/`), file);
    return Response.json({ ref }, { status: 201 });
  }
  if (req.method === "PATCH" && path.startsWith("git/refs/heads/")) {
    const branch = path.slice("git/refs/heads/".length);
    for (const key of [...files.keys()]) if (key.startsWith(`${repo}@${branch}/`)) files.delete(key);
    branchCommits.splice(0, branchCommits.length, ...branchCommits.filter((row) => row.at !== `${repo}:${branch}`));
    for (const [key, file] of files) if (key.startsWith(`${repo}@main/`)) files.set(key.replace("@main/", `@${branch}/`), file);
    return Response.json({ ref: `refs/heads/${branch}` });
  }
  if (req.method === "GET" && path === "pulls" && !url.searchParams.has("head")) {
    const open = pulls.filter((pull) => pull.repo === repo && pull.open);
    return Response.json(open.map((pull) => ({ number: pull.number, title: pull.title, user: { login: "triage", type: "Bot" }, draft: false, head: { ref: pull.head, sha: "head-sha", repo: { id: 1 } }, base: { repo: { id: 1 } }, updated_at: "2026-10-17T00:00:00Z", labels: [], html_url: `https://github.com/${repo}/pull/${pull.number}` })));
  }
  if (req.method === "GET" && path === "pulls") {
    const head = url.searchParams.get("head");
    return Response.json(pulls.filter((pull) => pull.repo === repo && pull.open && `${owner}:${pull.head}` === head).map((pull) => ({ number: pull.number, title: pull.title, body: pull.body, html_url: `https://github.com/${repo}/pull/${pull.number}`, head: { sha: "head-sha" } })));
  }
  if (req.method === "POST" && path === "pulls") {
    const body = await req.json() as { head: string; base: string; title: string; body: string };
    if (pulls.some((pull) => pull.repo === repo && pull.open && pull.head === body.head && pull.base === body.base)) return Response.json({ message: "Validation Failed" }, { status: 422 });
    pulls.push({ repo, number: pulls.length + 1, open: true, ...body });
    return Response.json({ number: pulls.length, html_url: `https://github.com/${repo}/pull/${pulls.length}`, head: { sha: "head-sha" } }, { status: 201 });
  }
  if (req.method === "GET" && /^pulls\/\d+\/commits$/.test(path)) {
    const pull = pulls.find((row) => row.repo === repo && row.number === Number(path.split("/")[1]))!;
    return Response.json(branchCommits.filter((row) => row.at === `${repo}:${pull.head}`).map((row) => ({ sha: row.sha, commit: { message: row.message } })));
  }
  if (req.method === "GET" && path.startsWith("pulls/")) {
    const pull = pulls.find((row) => row.repo === repo && row.number === Number(path.slice("pulls/".length)))!;
    return Response.json({ number: pull.number, title: pull.title, body: pull.body, html_url: `https://github.com/${repo}/pull/${pull.number}`, head: { sha: "head-sha" } });
  }
  if (req.method === "PATCH" && path.startsWith("pulls/")) {
    if (pullEditFailures > 0) {
      pullEditFailures -= 1;
      return new Response(null, { status: 502 });
    }
    const pull = pulls.find((row) => row.repo === repo && row.number === Number(path.slice("pulls/".length)))!;
    Object.assign(pull, await req.json());
    return Response.json({ number: pull.number, html_url: `https://github.com/${repo}/pull/${pull.number}`, head: { sha: "patched-head" } });
  }
  return new Response(null, { status: 404 });
}

/** Bitbucket Data Center over the same files, its head always `head`; a file's sha is the commit that last changed it. */
async function bitbucket(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(path, "https://bitbucket.example");
  const [, , , , , project, , slug, kind, ...rest] = url.pathname.split("/");
  const repo = `${project}/${slug}`;
  const key = `${repo}@main/${decodeURIComponent(rest.join("/")) || url.searchParams.get("path")}`;
  const file = files.get(key);
  if (kind === "restrictions") return Response.json({ values: restrictions.get(repo) ?? [], isLastPage: true });
  if (kind === undefined) return Response.json({ links: { self: [{ href: `https://bitbucket.example/projects/${project}/repos/${slug}/browse` }] } });
  if (kind === "browse" && init?.method === "PUT") {
    const form = init.body as FormData;
    if (form.get("branch") !== "main" || file?.sha !== form.get("sourceCommitId")) return new Response(null, { status: 409 });
    const id = `bbcommit${++commits}`;
    files.set(key, { sha: id, text: await (form.get("content") as Blob).text() });
    branchCommits.push({ at: `${repo}:main`, sha: id, message: String(form.get("message")) });
    return Response.json({ id });
  }
  if (kind === "branches") return Response.json({ latestCommit: "head", values: [{ displayId: "main", latestCommit: "head" }] });
  if (!file) return new Response(null, { status: 404 });
  if (kind === "browse") return Response.json({ type: "FILE" });
  if (kind === "raw") return new Response(file.text);
  return Response.json({ values: [{ id: file.sha }] });
}

const server = Bun.serve({ port: 0, fetch: github });
const githubApiOrigin = `http://127.0.0.1:${server.port}`;
const database = `corbits_policy_file_${randomBytes(6).toString("hex")}`;
const config = { ...TEST_DB, database };
const admin = createDB(TEST_DB);
let handle: ReturnType<typeof createDB>;
let policyFile: ReturnType<typeof createPolicyFile>;
const activity = createRepoActivity(() => new Date(), { quietMs: 30 * 60_000, graceMs: 60_000 });

beforeAll(async () => {
  await admin.db.execute(sql.raw(`create database ${database}`));
  await runMigrations(config, { schema: "public" });
  handle = createDB(config);
  const db = handle.db;
  const cipher = createEnvKeyCredentialCipher(new Uint8Array(32).fill(7));
  const repos = [...[FROM_FILE, STARTER, PATCHED, PATCH_LISTED, PUSHED].map((name) => ({ name, connected: true, enabled: true, installationId: 1 })), { name: SHARED, connected: true, enabled: false, installationId: 1 }, { name: CHOSEN, connected: true, enabled: false, installationId: 1 }, { name: CHOSEN_RACED, connected: true, enabled: false, installationId: 1 }, { name: EXTENDS, connected: true, enabled: true, installationId: 1 }, { name: BITBUCKET_PUSHED, source: "bitbucket-datacenter", connected: true, enabled: true, defaultBranch: "main" }, { name: BOTH, connected: true, enabled: true, installationId: 1 }, { name: BOTH, source: "bitbucket-datacenter", connected: true, enabled: true }, { name: UNHEARD, connected: true, enabled: true, installationId: 1 }, { name: BITBUCKET_UNHEARD, source: "bitbucket-datacenter", connected: true, enabled: true }];
  await db.insert(schema.tenant).values({ id: TENANT, name: "Policy file", slug: "policy-file", domain: "policy-file.test", config: { corbitsTriage: { repos } } });
  await db.insert(schema.principal).values([
    { id: "prn_user", tenantId: TENANT, kind: "user", refId: "usr_user", status: "active" },
    { id: "prn_plain", tenantId: TENANT, kind: "user", refId: "usr_plain", status: "active" },
    { id: "prn_github", tenantId: TENANT, kind: "user", refId: "github", status: "active" },
  ]);
  await db.insert(schema.provider).values([
    { id: "prv_github", tenantId: TENANT, name: "github", plugin: "http", apiBaseUrl: githubApiOrigin },
    { id: "prv_bb", tenantId: TENANT, name: PROVIDER, plugin: "http", apiBaseUrl: "https://bitbucket.example" },
  ]);
  await db.insert(schema.credential).values({ id: "crd_bb", tenantId: TENANT, principalId: null, providerId: "prv_bb", oauthClientId: null, name: TOKEN_CREDENTIAL, type: "api_key", secret: "unused", status: "active" });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  await db.insert(schema.credential).values({
    id: "crd_github", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key",
    secret: await cipher.encrypt(JSON.stringify({ appId: "1", privateKey }), credentialAad("crd_github", "secret")), status: "active", metadata: { appSlug: "triage" },
  });
  async function authorize(principalId: string, _tenantId: string, resource: string, action: string) {
    if (resource === "grant:*") return action === "create" && principalId === "prn_user";
    return (resource === "credential:crd_github" || resource === "credential:crd_bb") && action === "use" && (principalId === "prn_user" || principalId === "prn_plain");
  }
  const list = createTenantOpenPrs({ db, cipher, onKeyMoved: noKeyPush, githubApiOrigin, tenantBitbucket: async () => undefined });
  policyFile = createPolicyFile({
    db,
    openPulls: createMemberOpenPulls({ db, cipher, onKeyMoved: noKeyPush, authorize, list, cache: createOpenPullsCache(() => new Date()) }),
    changed() {},
    refusal: refused,
    cipher,
    onKeyMoved: noKeyPush,
    tenantBitbucket: async () => bitbucket,
    authorize,
    tenantGithub: createTenantGithub({ db, cipher, onKeyMoved: noKeyPush, githubApiOrigin }),
    log() {},
    quiet: activity.quiet,
    async waitingKinds() { return []; },
  });
}, 120_000);

afterAll(async () => {
  server.stop(true);
  await handle?.close();
  await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
  await admin.close();
});

function policyDeps() {
  return { async automaticKinds() { return []; }, policyFile: policyFile.current };
}

function refused(tenantId: string, repo: string, source: RepoSource, policy: Record<string, unknown>) {
  return fileRefusal(policyDeps(), tenantId, repo, source, policy);
}

function readPack(repo: string, source: RepoSource = "github") {
  return readRepoPolicy(policyDeps(), TENANT, repo, source);
}

async function upgrades(): Promise<Array<Record<string, unknown>>> {
  return ((await (await policyFile.upgradesRoute(MEMBER)).json()) as { repos: Array<Record<string, unknown>> }).repos;
}

async function upgradeOf(repo: string): Promise<Record<string, unknown> | undefined> {
  return (await upgrades()).find((row) => row.repo === repo);
}

async function exportOf(repo: string, text?: string, sha?: string | null): Promise<Record<string, unknown>> {
  const res = await policyFile.exportRoute({ repo, ...(text !== undefined && { text }), ...(sha !== undefined && { sha }) }, MEMBER);
  return { http: res.status, ...(await res.json() as Record<string, unknown>) };
}

async function pushOf(repo: string, source: RepoSource, text: string, sha: string, member = MEMBER): Promise<Record<string, unknown>> {
  const res = await policyFile.pushRoute({ repo, source, text, sha }, member);
  return { http: res.status, ...(await res.json() as Record<string, unknown>) };
}

async function pushAccessOf(repo: string, source: RepoSource): Promise<unknown> {
  return (await policyFile.pushAccessRoute({ repo, source }, MEMBER)).json();
}

async function patchOf(body: typeof PolicyPatchBody.infer): Promise<Record<string, unknown>> {
  const res = await policyFile.patchRoute(body, MEMBER);
  return { http: res.status, ...(await res.json() as Record<string, unknown>) };
}

async function fileOf(repo: string, source?: RepoSource): Promise<unknown> {
  const res = await policyFile.fileRoute({ repo, ...(source && { source }) }, MEMBER);
  return ((await res.json()) as { file: unknown }).file;
}

/** Each level holds eight of the one before, so ten levels expand to a billion strings once serialised. */
function aliasBomb(): string {
  const levels = Array.from({ length: 10 }, (_, i) => `l${i + 1}: &l${i + 1} [${Array(8).fill(i === 0 ? '"x"' : `*l${i}`).join(", ")}]`);
  return `checks: {}\nbomb:\n${levels.map((line) => `  ${line}`).join("\n")}\n`;
}

test("PostgreSQL: the policy file is the policy while it is there, a refused one stops triage rather than fall back, and a push reads it again", async () => {
  expect(await readPack(FROM_FILE)).toEqual({ status: "missing" });
  expect(await fileOf(FROM_FILE)).toBeNull();

  // The answer is kept until a push to the default branch says the file changed.
  onMain(FROM_FILE, YML, FILE, "blob1");
  expect(await readPack(FROM_FILE)).toEqual({ status: "missing" });
  expect(await policyFile.onPush(TENANT, FROM_FILE, "github")).toMatchObject({ status: "ok", file: { path: YML, sha: "blob1" } });
  const read = await readPack(FROM_FILE);
  expect(read).toEqual({ status: "ok", pack: expect.anything(), automatic: [], source: { file: { path: YML, sha: "blob1" } } });
  expect(read.status === "ok" && read.pack.checks).toEqual({ "ci-green": { enabled: true, text: "CI passes.", reason: "Required by branch protection.", evidence: ["maintainer-stated"] } });
  expect(await fileOf(FROM_FILE)).toEqual({ path: YML, sha: "blob1", url: `https://github.com/${FROM_FILE}/blob/main/${YML}`, text: FILE });
  expect(await upgradeOf(FROM_FILE)).toEqual({ repo: FROM_FILE, source: "github", upgrade: { state: "ok" } });

  const manyKeys = Array.from({ length: 7 }, (_, i) => `k${i}: 1`).join("\n");
  const refused: Array<[string | null, string]> = [
    ["rules: [", "Line 1: The policy file is not YAML: Flow sequence in block collection must be sufficiently indented and end with a ]."],
    [`rules:\n  - check: ci-green\n    text: CI passes.\n    evidence: [maintainer-stated]\n`, "Line 2: rules[0].reason must be"],
    [`checks: {}\n${manyKeys}\n`, "unknown keys: k0, k1, k2, k3, k4 and 2 more."],
    ["checks:\n  ci-gren:\n    enabled: true\n", "unknown checks: ci-gren."],
    [DIRECTORY, `${YML} is not a file.`],
    [aliasBomb(), "too large or uses aliases"],
    [`checks: {}\n#${"x".repeat(70 * 1024)}\n`, "too large or uses aliases"],
    [null, "too large or uses aliases"],
  ];
  for (const [i, [text, reason]] of refused.entries()) {
    onMain(FROM_FILE, YML, text === DIRECTORY ? null : text, text === DIRECTORY ? DIRECTORY : `bad${i}`);
    const started = performance.now();
    await policyFile.onPush(TENANT, FROM_FILE, "github");
    expect(await readPack(FROM_FILE)).toEqual({ status: "invalid", path: YML, reason: expect.stringContaining(reason), automatic: [] });
    expect(performance.now() - started).toBeLessThan(2_000);
    if (text === DIRECTORY) {
      expect((await policyFile.fileRoute({ repo: FROM_FILE }, MEMBER)).status).toBe(422);
      continue;
    }
    expect(await fileOf(FROM_FILE)).toMatchObject({ sha: `bad${i}`, problem: expect.stringContaining(reason) });
  }

  // `.yml` is read first; `.yaml` still counts when it is the only one.
  files.delete(`${FROM_FILE}@main/${YML}`);
  onMain(FROM_FILE, YAML, FILE, "blob2");
  await policyFile.onPush(TENANT, FROM_FILE, "github");
  expect(await readPack(FROM_FILE)).toMatchObject({ status: "ok", source: { file: { path: YAML, sha: "blob2" } } });

  // A push whose read fails keeps nothing, so the next trigger reads the file itself.
  files.delete(`${FROM_FILE}@main/${YAML}`);
  readFails = true;
  await expect(policyFile.onPush(TENANT, FROM_FILE, "github")).rejects.toThrow("502");
  readFails = false;
  expect(await readPack(FROM_FILE)).toEqual({ status: "missing" });
}, 60_000);

test("PostgreSQL: a repository with no policy file runs nothing and is offered a starter file through one pull request, left as edited and run once merged", async () => {
  expect(await upgradeOf(STARTER)).toEqual({ repo: STARTER, source: "github", upgrade: { state: "start" } });
  expect(await readPack(STARTER)).toEqual({ status: "missing" });

  const number = pulls.length + 1;
  expect(await exportOf(STARTER)).toEqual({ http: 200, status: "opened", url: `https://github.com/${STARTER}/pull/${number}`, number, headSha: "head-sha" });
  expect(pulls.filter((row) => row.repo === STARTER)).toMatchObject([{ head: POLICY_BRANCH, base: "main", title: `chore: add a Corbits Triage policy in ${YML}` }]);
  // Opening it lists the workspace's pull requests again; a reload then finds it in that listing without asking GitHub.
  requests.length = 0;
  expect(await upgradeOf(STARTER)).toEqual({ repo: STARTER, source: "github", upgrade: { state: "start" }, pull: { url: `https://github.com/${STARTER}/pull/${number}`, number, headSha: "head-sha" } });
  expect(requests.filter((request) => request.includes(STARTER))).toEqual([]);

  // Asking again answers the open pull request and keeps the maintainer's edit on its branch.
  const branchFile = `${STARTER}@${POLICY_BRANCH}/${YML}`;
  const edited = files.get(branchFile)!.text!.replace("max: 30", "max: 40");
  files.set(branchFile, { sha: "edited", text: edited });
  expect(await exportOf(STARTER)).toEqual({ http: 200, status: "opened", url: `https://github.com/${STARTER}/pull/${number}`, number, headSha: "head-sha" });
  expect(files.get(branchFile)).toEqual({ sha: "edited", text: edited });
  expect(pulls.filter((row) => row.repo === STARTER)).toHaveLength(1);

  onMain(STARTER, YML, files.get(`${STARTER}@${POLICY_BRANCH}/${YML}`)!.text);
  pulls.find((row) => row.repo === STARTER)!.open = false;
  await policyFile.onPush(TENANT, STARTER, "github");
  const read = await readPack(STARTER);
  expect(read).toMatchObject({ status: "ok", source: { file: { path: YML } } });
  expect(read.status === "ok" && read.pack.checks["max-files-changed"]).toMatchObject({ enabled: true, maxFiles: 40 });
  // The merged pull request leaves the upgrades read once the shared listing is listed again.
  setSystemTime(new Date(Date.now() + 10_000));
  expect(await upgradeOf(STARTER)).toEqual({ repo: STARTER, source: "github", upgrade: { state: "ok" } });
  setSystemTime();
  expect(await exportOf(STARTER)).toMatchObject({ http: 409, error: { code: "policy_file_present" } });
}, 60_000);

test("PostgreSQL: edited text is opened as a pull request as triage would run it, over the file it was edited from, and the open pull request is left as it is", async () => {
  expect(await exportOf(CHOSEN, "rules: [", null)).toMatchObject({ http: 422, error: { code: "policy_file_invalid", message: expect.stringContaining("Line 1: The policy file is not YAML") } });
  expect(await exportOf(CHOSEN, "extends: acme/nowhere\nchecks: {}\n", null)).toMatchObject({ http: 422, error: { code: "policy_file_invalid", message: "acme/nowhere is not connected to this workspace or has no policy file." } });
  expect(await exportOf(CHOSEN, FILE, "blob-never")).toMatchObject({ http: 409, error: { code: "policy_file_changed" } });
  expect(pulls.filter((row) => row.repo === CHOSEN)).toEqual([]);

  const number = pulls.length + 1;
  const url = `https://github.com/${CHOSEN}/pull/${number}`;
  expect(await exportOf(CHOSEN, FILE)).toMatchObject({ http: 400, error: { code: "invalid_request" } });
  expect(await exportOf(CHOSEN, FILE, null)).toEqual({ http: 200, status: "opened", url, number, headSha: "head-sha" });
  expect(pulls.filter((row) => row.repo === CHOSEN)).toMatchObject([{ head: POLICY_BRANCH, base: "main", title: `chore: add a Corbits Triage policy in ${YML}` }]);
  expect(files.get(`${CHOSEN}@${POLICY_BRANCH}/${YML}`)!.text).toBe(FILE);

  expect(await exportOf(CHOSEN, FILE.replace("CI passes.", "CI is green."), null)).toMatchObject({ http: 409, error: { code: "policy_pull_open", url, number } });
  expect(files.get(`${CHOSEN}@${POLICY_BRANCH}/${YML}`)!.text).toBe(FILE);

  // Merged where no push is heard, the file is still found, and an edit goes over it from the sha it was made from.
  onMain(CHOSEN, YML, FILE, "chosen1");
  pulls.find((row) => row.repo === CHOSEN)!.open = false;
  expect(await exportOf(CHOSEN, FILE, "chosen1")).toMatchObject({ http: 409, error: { code: "policy_file_unchanged" } });
  const edited = FILE.replace("CI passes.", "CI is green.");
  expect(await exportOf(CHOSEN, edited, null)).toMatchObject({ http: 409, error: { code: "policy_file_changed" } });
  expect(await exportOf(CHOSEN, edited, "chosen0")).toMatchObject({ http: 409, error: { code: "policy_file_changed" } });
  expect(await exportOf(CHOSEN, edited, "chosen1")).toMatchObject({ http: 200, status: "opened" });
  expect(pulls.filter((row) => row.repo === CHOSEN && row.open)).toMatchObject([{ title: `chore: update the Corbits Triage rules in ${YML}` }]);
  expect(files.get(`${CHOSEN}@${POLICY_BRANCH}/${YML}`)!.text).toBe(edited);
  expect(files.get(`${CHOSEN}@main/${YML}`)!.text).toBe(FILE);

  // Another caller opening it between the check and the create is answered with theirs.
  const theirs = pulls.length + 1;
  raced = { repo: CHOSEN_RACED, number: theirs, head: POLICY_BRANCH, base: "main", title: "theirs", body: "", open: true };
  expect(await exportOf(CHOSEN_RACED, FILE, null)).toMatchObject({ http: 200, number: theirs });
  expect(pulls.filter((row) => row.repo === CHOSEN_RACED)).toHaveLength(1);
}, 60_000);

test("PostgreSQL: a policy file extending another repository runs over that repository's file as last pushed, and is refused while that file cannot be read or extends again", async () => {
  onMain(EXTENDS, YML, `extends: ${SHARED}\nrules:\n  - check: max-files-changed\n    max: 50\n    text: At most 50 files.\n    reason: Reviewable.\n    evidence: [maintainer-stated]\n`, "own1");
  await policyFile.onPush(TENANT, EXTENDS, "github");
  expect(await readPack(EXTENDS)).toEqual({ status: "invalid", path: YML, reason: `${SHARED} is not connected to this workspace or has no policy file.`, automatic: [] });

  onMain(SHARED, YML, FILE, "shared1");
  await policyFile.onPush(TENANT, SHARED, "github");
  const read = await readPack(EXTENDS);
  expect(read).toMatchObject({ status: "ok", source: { file: { path: YML, sha: "own1" }, sharedFile: { repo: SHARED, path: YML, sha: "shared1" } } });
  expect(read.status === "ok" && Object.keys(read.pack.checks)).toEqual(["ci-green", "max-files-changed"]);

  // A push to the shared repository reaches every repository extending it.
  onMain(SHARED, YML, `extends: ${EXTENDS}\n${FILE}`, "shared2");
  await policyFile.onPush(TENANT, SHARED, "github");
  expect(await readPack(EXTENDS)).toEqual({ status: "invalid", path: YML, reason: `${SHARED}'s policy extends another, so no policy can extend it.`, automatic: [] });

  onMain(SHARED, YML, "rules: [", "shared3");
  await policyFile.onPush(TENANT, SHARED, "github");
  expect(await readPack(EXTENDS)).toEqual({ status: "invalid", path: YML, reason: expect.stringContaining(`${SHARED}'s policy file is refused: Line 1: The policy file is not YAML`), automatic: [] });
});

test("PostgreSQL: a name both hosts hold is read only for the host asked, a route naming the host reads it, one naming no host refuses it, and its upgrade row names its host", async () => {
  onMain(BOTH, YML, FILE, "both1");
  await policyFile.onPush(TENANT, BOTH, "github");
  expect(await readPack(BOTH)).toMatchObject({ status: "ok", source: { file: { path: YML, sha: "both1" } } });
  expect((await policyFile.fileRoute({ repo: BOTH }, MEMBER)).status).toBe(409);
  expect((await (await policyFile.fileRoute({ repo: BOTH, source: "github" }, MEMBER)).json()) as unknown).toMatchObject({ file: { path: YML, sha: "both1" } });
  expect(await upgrades()).toContainEqual(expect.objectContaining({ repo: BOTH, source: "bitbucket-datacenter" }));
});

test("PostgreSQL: where no webhook is heard a merged policy file is read within a minute without a push, and kept while the webhook is heard", async () => {
  const start = Date.now();
  function after(ms: number): void {
    setSystemTime(new Date(start + ms));
  }
  try {
    for (const [repo, source] of [[UNHEARD, "github"], [BITBUCKET_UNHEARD, "bitbucket-datacenter"]] as const) {
      after(0);
      expect(await readPack(repo, source)).toEqual({ status: "missing" });
      onMain(repo, YML, FILE, `${source}1`);
      after(61_000);
      expect(await readPack(repo, source)).toMatchObject({ status: "ok", source: { file: { sha: `${source}1` } } });
      activity.heard(TENANT, source, repo);
      onMain(repo, YML, FILE, `${source}2`);
      after(122_000);
      expect(await readPack(repo, source)).toMatchObject({ status: "ok", source: { file: { sha: `${source}1` } } });
      after(61_000 + 30 * 60_000);
      expect(await readPack(repo, source)).toMatchObject({ status: "ok", source: { file: { sha: `${source}2` } } });
    }
  } finally {
    setSystemTime();
  }
});

test("a Bitbucket policy pull request carries no head, so it is merged on Bitbucket, and each host's is found only for its own repository", () => {
  const pr = { number: 4, title: "Add the policy file", author: "triage", draft: false, sha: "bb-head", branch: POLICY_BRANCH, updatedAt: "2026-10-17T00:00:00Z", labels: [], url: "https://bitbucket.example/pr/4" };
  const listing = (source: RepoSource) => ({ at: 0, repos: [{ repo: "PROJ/widgets", source, prs: [pr] }] });
  expect(listedPolicyPull(listing("bitbucket-datacenter"), "PROJ/widgets", "bitbucket-datacenter")).toEqual({ url: pr.url, number: 4 });
  expect(listedPolicyPull(listing("github"), "PROJ/widgets", "github")).toEqual({ url: pr.url, number: 4, headSha: "bb-head" });
  expect(listedPolicyPull(listing("github"), "PROJ/widgets", "bitbucket-datacenter")).toBeUndefined();
});

const PATCH_FILE = `# Corbits Triage policy.
rules:
  # leave ci-green alone
  - check: ci-green
    text: CI passes.
    reason: Required by branch protection.
    evidence: [maintainer-stated]
  - check: focused
    text: One focused change.
    reason: Mixed changes were split.
    evidence: [maintainer-stated]
  - check: max-lines-changed
    text: Flag pull requests over 400 lines changed.
    reason: Review load.
    evidence: [maintainer-stated]
    max: 400
pauseLabel: hold
code-review:
  on: false
  provider: anthropic
`;

const PATCH_CHANGES = [
  { kind: "rule" as const, id: "focused", enabled: false },
  { kind: "rule-options" as const, id: "max-lines-changed", options: { max: 200 } },
  { kind: "rule" as const, id: "docs", enabled: true },
  { kind: "rule-options" as const, id: "docs", options: { reason: "Docs drift from the code." } },
  { kind: "code-review" as const, on: true },
];

test("PostgreSQL: a batch of policy edits opens one pull request, a preview writes nothing, and the same batch again makes no new commit", async () => {
  const absent = await patchOf({ repo: PATCHED, changes: PATCH_CHANGES });
  expect(absent).toMatchObject({ http: 409, error: { code: "policy_file_absent" } });
  expect(pulls.filter((row) => row.repo === PATCHED)).toEqual([]);

  onMain(PATCHED, YML, PATCH_FILE, "patch-main");
  const refused = await patchOf({ repo: PATCHED, changes: [{ kind: "rule", id: "made-up", enabled: true }] });
  expect(refused).toMatchObject({ http: 422, error: { code: "policy_file_invalid", message: "Unknown rule made-up." } });
  expect(files.has(`${PATCHED}@${POLICY_BRANCH}/${YML}`)).toBe(false);
  expect(pulls.filter((row) => row.repo === PATCHED)).toEqual([]);

  const preview = await patchOf({ repo: PATCHED, changes: PATCH_CHANGES, preview: true });
  expect(preview.http).toBe(200);
  expect(preview.before).toBe(PATCH_FILE);
  expect(preview.after).toEqual(expect.any(String));
  expect(String(preview.after)).toContain("# leave ci-green alone");
  expect(String(preview.after)).toContain("text: CI passes.");
  expect(String(preview.after)).not.toBe(PATCH_FILE);
  expect(files.get(`${PATCHED}@main/${YML}`)?.text).toBe(PATCH_FILE);
  expect(files.has(`${PATCHED}@${POLICY_BRANCH}/${YML}`)).toBe(false);
  expect(pulls.filter((row) => row.repo === PATCHED)).toEqual([]);

  const noop = await patchOf({ repo: PATCHED, changes: [{ kind: "rule-options", id: "max-lines-changed", options: { max: 400 } }] });
  expect(noop).toEqual({ http: 200, before: PATCH_FILE, after: PATCH_FILE });
  expect(files.has(`${PATCHED}@${POLICY_BRANCH}/${YML}`)).toBe(false);
  expect(pulls.filter((row) => row.repo === PATCHED)).toEqual([]);

  const number = pulls.length + 1;
  const opened = await patchOf({ repo: PATCHED, changes: PATCH_CHANGES });
  expect(opened).toEqual({ http: 200, status: "opened", url: `https://github.com/${PATCHED}/pull/${number}`, number, headSha: "head-sha" });
  const title = `chore: update the Corbits Triage rules in ${YML}`;
  expect(pulls.filter((row) => row.repo === PATCHED)).toMatchObject([{ number, head: POLICY_BRANCH, base: "main", title }]);
  const written = files.get(`${PATCHED}@${POLICY_BRANCH}/${YML}`)!;
  expect(written.text).toContain("# leave ci-green alone");
  expect(written.text).toContain("text: CI passes.");
  expect(written.text).toContain("pauseLabel: hold");
  expect(written.text).toContain("provider: anthropic");
  expect(written.text).toContain("max: 200");
  expect(written.text).toContain("Check docs are updated when behavior changes.");
  expect(checkPolicyFile(written.text!, PATCHED)).toMatchObject({ ok: true });

  const sha = written.sha;
  const again = await patchOf({ repo: PATCHED, changes: PATCH_CHANGES });
  expect(again).toEqual({ http: 200, before: written.text, after: written.text });
  expect(pulls.filter((row) => row.repo === PATCHED)).toHaveLength(1);
  expect(files.get(`${PATCHED}@${POLICY_BRANCH}/${YML}`)?.sha).toBe(sha);

  // An edit made on the open pull request's branch is what the next patch reads, so it is not overwritten from the default branch.
  const branchKey = `${PATCHED}@${POLICY_BRANCH}/${YML}`;
  const edited = files.get(branchKey)!.text!.replace("# leave ci-green alone", "# leave ci-green alone\n  # edited on the pull request");
  files.set(branchKey, { sha, text: edited });
  const follow = await patchOf({ repo: PATCHED, changes: [{ kind: "rule", id: "ci-green", enabled: false }] });
  expect(follow).toMatchObject({ http: 200, number });
  expect(files.get(branchKey)?.text).toContain("# edited on the pull request");
  expect(files.get(branchKey)?.text).toContain("# leave ci-green alone");
  const [pull] = pulls.filter((row) => row.repo === PATCHED);
  expect(pull).toMatchObject({ title });
  expect(pull!.body.split("Turns off `focused`.")).toHaveLength(2);
  expect(pull!.body.endsWith("- Turns off `ci-green`.")).toBe(true);

  // A commit to the branch between the route's read and its write is not overwritten.
  const before = files.get(branchKey)!;
  movedAfterRead = branchKey;
  const stale = await patchOf({ repo: PATCHED, changes: [{ kind: "code-review", on: false }] });
  expect(stale).toMatchObject({ http: 409, error: { code: "policy_file_changed" } });
  expect(files.get(branchKey)?.text).toBe(before.text);
  expect(files.get(branchKey)?.sha).not.toBe(before.sha);

  // An open pull request whose branch has no policy file gets one, built from the default branch's.
  files.delete(branchKey);
  const created = await patchOf({ repo: PATCHED, changes: [{ kind: "rule", id: "focused", enabled: false }] });
  expect(created).toMatchObject({ http: 200, number });
  expect(files.get(branchKey)?.text).toContain("pauseLabel: hold");
  expect(files.get(branchKey)?.text).toContain("enabled: false");
  expect(files.get(`${PATCHED}@main/${YML}`)?.text).toBe(PATCH_FILE);

  // Two batches sent together both commit and both reach the body.
  const together = await Promise.all([
    patchOf({ repo: PATCHED, changes: [{ kind: "rule", id: "focused", enabled: true }] }),
    patchOf({ repo: PATCHED, changes: [{ kind: "code-review", on: true }] }),
  ]);
  expect(together).toMatchObject([{ http: 200, number }, { http: 200, number }]);
  const both = pulls.find((row) => row.repo === PATCHED)!.body;
  expect(both).toContain("Turns on `focused`.");
  expect(both).toContain("Turns on code review.");

  // A commit whose description edit kept failing is named in the refusal, and the next batch adds its section.
  pullEditFailures = 4;
  const lost = await patchOf({ repo: PATCHED, changes: [{ kind: "code-review", on: false }] });
  const lostCommit = branchCommits.at(-1)!.sha;
  expect(lost).toMatchObject({ http: 502, error: { code: "description_not_updated", message: expect.stringContaining(lostCommit) } });
  expect(pulls.find((row) => row.repo === PATCHED)!.body).not.toContain("Turns off code review.");
  const repaired = await patchOf({ repo: PATCHED, changes: [{ kind: "rule", id: "focused", enabled: false }] });
  expect(repaired).toMatchObject({ http: 200, number });
  const body = pulls.find((row) => row.repo === PATCHED)!.body;
  expect(body).toContain("Turns off code review.");
  expect(body.indexOf("Turns off code review.")).toBeLessThan(body.lastIndexOf("Turns off `focused`."));
});

test("PostgreSQL: a repository with a policy file reads ok with its open policy pull request, which a patch shows at once", async () => {
  onMain(PATCH_LISTED, YML, PATCH_FILE);
  await policyFile.onPush(TENANT, PATCH_LISTED, "github");
  expect(await upgradeOf(PATCH_LISTED)).toEqual({ repo: PATCH_LISTED, source: "github", upgrade: { state: "ok" } });

  const opened = await patchOf({ repo: PATCH_LISTED, changes: [{ kind: "rule", id: "focused", enabled: false }] });
  expect(opened).toMatchObject({ http: 200, status: "opened" });
  const { number, url } = opened as { number: number; url: string };
  expect(await upgradeOf(PATCH_LISTED)).toEqual({ repo: PATCH_LISTED, source: "github", upgrade: { state: "ok" }, pull: { url, number, headSha: "head-sha" } });
});

test("PostgreSQL: edited text is pushed to the default branch as one commit where its rules let the hub push, on both hosts, and refused where they do not or the file moved", async () => {
  for (const [repo, source] of [[PUSHED, "github"], [BITBUCKET_PUSHED, "bitbucket-datacenter"]] as const) {
    onMain(repo, YML, FILE, `${source}-push1`);
    expect(await pushAccessOf(repo, source)).toEqual({ branch: "main", allowed: true });
    const edited = FILE.replace("CI passes.", "CI is green.");
    expect(await pushOf(repo, source, "rules: [", `${source}-push1`)).toMatchObject({ http: 422, error: { code: "policy_file_invalid" } });
    expect(await pushOf(repo, source, edited, "stale")).toMatchObject({ http: 409, error: { code: "policy_file_changed" } });
    expect(await pushOf(repo, source, FILE, `${source}-push1`)).toMatchObject({ http: 409, error: { code: "policy_file_unchanged" } });
    expect(await pushOf(repo, source, edited, `${source}-push1`, USER)).toMatchObject({ http: 403, error: { code: "forbidden" } });
    const pushed = await pushOf(repo, source, edited, `${source}-push1`);
    expect(pushed).toEqual({ http: 200, status: "pushed", path: YML, sha: files.get(`${repo}@main/${YML}`)!.sha, commit: expect.any(String) });
    expect(files.get(`${repo}@main/${YML}`)!.text).toBe(edited);
    expect(branchCommits.filter((row) => row.at === `${repo}:main`).map((row) => row.message)).toEqual([POLICY_PUSH_MESSAGE]);
    // The kept read is dropped, so the file route answers the pushed file before its webhook is heard.
    expect(await fileOf(repo, source)).toMatchObject({ sha: pushed.sha, text: edited });
    expect(await pushOf(repo, source, FILE, `${source}-push1`)).toMatchObject({ http: 409, error: { code: "policy_file_changed" } });
  }

  protectedBranches.add(PUSHED);
  expect(await pushAccessOf(PUSHED, "github")).toMatchObject({ allowed: false, reason: expect.stringContaining("protected") });
  protectedBranches.delete(PUSHED);
  branchRules.set(PUSHED, [{ type: "deletion" }, { type: "pull_request" }]);
  expect(await pushAccessOf(PUSHED, "github")).toMatchObject({ allowed: false, reason: expect.stringContaining("pull_request") });
  const current = files.get(`${PUSHED}@main/${YML}`)!;
  expect(await pushOf(PUSHED, "github", FILE, current.sha)).toMatchObject({ http: 409, error: { code: "push_refused" } });
  expect(files.get(`${PUSHED}@main/${YML}`)).toEqual(current);

  const matcher = (type: string, id: string) => ({ id, displayId: id.replace("refs/heads/", ""), type: { id: type } });
  restrictions.set(BITBUCKET_PUSHED, [{ type: "pull-request-only", matcher: matcher("BRANCH", "refs/heads/release"), users: [] }, { type: "fast-forward-only", matcher: matcher("BRANCH", "refs/heads/main"), users: [] }]);
  expect(await pushAccessOf(BITBUCKET_PUSHED, "bitbucket-datacenter")).toEqual({ branch: "main", allowed: true });
  restrictions.set(BITBUCKET_PUSHED, [{ type: "read-only", matcher: matcher("PATTERN", "ma*"), users: [] }]);
  expect(await pushAccessOf(BITBUCKET_PUSHED, "bitbucket-datacenter")).toMatchObject({ allowed: false, reason: expect.stringContaining("read-only") });
  const bitbucketCurrent = files.get(`${BITBUCKET_PUSHED}@main/${YML}`)!;
  expect(await pushOf(BITBUCKET_PUSHED, "bitbucket-datacenter", FILE, bitbucketCurrent.sha)).toMatchObject({ http: 409, error: { code: "push_refused" } });
  expect(files.get(`${BITBUCKET_PUSHED}@main/${YML}`)).toEqual(bitbucketCurrent);
});
