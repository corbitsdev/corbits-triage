// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { createArtifact, findArtifactByTitle, runArtifactMigrations } from "@corbits/artifacts";
import { checkPackName, emptyPack, exportPolicyFile, policyDifferences, readPolicyFile, starterPack, type CheckPack, type RepoSource } from "@corbits/triage-contracts";
import { PROVIDER, TOKEN_CREDENTIAL } from "../bitbucket-datacenter/names.js";
import { fileRefusal, settlePolicy } from "./check-pack-store.js";
import { createPolicyFile, listedPolicyPull } from "./policy-file.js";
import { POLICY_BRANCH } from "./policy-pull.js";
import { createMemberOpenPulls, createOpenPullsCache } from "./open-pulls.js";
import { createRepoActivity } from "./repo-activity.js";
import { createTenantGithub, createTenantOpenPrs } from "./tenant-open-heads.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_policy_file";
const FROM_FILE = "acme/from-file";
const SAVED = "acme/saved";
const EXPORTED = "acme/exported";
const STARTER = "acme/starter";
const OFF = "acme/off";
const SHARED = "acme/shared";
const EXTENDS = "acme/extends";
const CHOSEN = "acme/chosen";
const CHOSEN_SAVED = "acme/chosen-saved";
const CHOSEN_RACED = "acme/chosen-raced";
const BOTH = "acme/both";
const UNHEARD = "acme/unheard";
const BITBUCKET_UNHEARD = "PROJ/unheard";
const MEMBER = { tenantId: TENANT, principalId: "prn_user" };
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
    const file = files.get(`${repo}@${url.searchParams.get("ref") ?? "main"}/${at}`);
    if (!file) return new Response(null, { status: 404 });
    if (file.sha === DIRECTORY) return Response.json([{ type: "file", name: "inner.yaml" }]);
    const content = file.text === null ? { content: "", encoding: "none" } : { content: Buffer.from(file.text).toString("base64"), encoding: "base64" };
    return Response.json({ type: "file", sha: file.sha, ...content, html_url: `https://github.com/${repo}/blob/main/${at}` });
  }
  if (req.method === "PUT" && path.startsWith("contents/")) {
    const at = path.slice("contents/".length);
    const { branch, content, sha } = await req.json() as { branch: string; content: string; sha?: string };
    if (!refs.has(`${repo}:${branch}`)) return Response.json({ message: "Branch not found" }, { status: 404 });
    if (files.get(`${repo}@${branch}/${at}`)?.sha !== sha) return Response.json({ message: "sha does not match" }, { status: 409 });
    files.set(`${repo}@${branch}/${at}`, { sha: `blob${++commits}`, text: Buffer.from(content, "base64").toString("utf8") });
    if (raced) pulls.push(raced);
    raced = undefined;
    return Response.json({ content: { sha: `blob${commits}` }, commit: { sha: `commit${commits}` } }, { status: 201 });
  }
  if (req.method === "GET" && path === "") return Response.json({ default_branch: "main" });
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
    for (const [key, file] of files) if (key.startsWith(`${repo}@main/`)) files.set(key.replace("@main/", `@${branch}/`), file);
    return Response.json({ ref: `refs/heads/${branch}` });
  }
  if (req.method === "GET" && path === "pulls" && !url.searchParams.has("head")) {
    const open = pulls.filter((pull) => pull.repo === repo && pull.open);
    return Response.json(open.map((pull) => ({ number: pull.number, title: pull.title, user: { login: "triage", type: "Bot" }, draft: false, head: { ref: pull.head, sha: "head-sha", repo: { id: 1 } }, base: { repo: { id: 1 } }, updated_at: "2026-10-17T00:00:00Z", labels: [], html_url: `https://github.com/${repo}/pull/${pull.number}` })));
  }
  if (req.method === "GET" && path === "pulls") {
    const head = url.searchParams.get("head");
    return Response.json(pulls.filter((pull) => pull.repo === repo && pull.open && `${owner}:${pull.head}` === head).map((pull) => ({ number: pull.number, html_url: `https://github.com/${repo}/pull/${pull.number}`, head: { sha: "head-sha" } })));
  }
  if (req.method === "POST" && path === "pulls") {
    const body = await req.json() as { head: string; base: string; title: string; body: string };
    if (pulls.some((pull) => pull.repo === repo && pull.open && pull.head === body.head && pull.base === body.base)) return Response.json({ message: "Validation Failed" }, { status: 422 });
    pulls.push({ repo, number: pulls.length + 1, open: true, ...body });
    return Response.json({ number: pulls.length, html_url: `https://github.com/${repo}/pull/${pulls.length}`, head: { sha: "head-sha" } }, { status: 201 });
  }
  if (req.method === "PATCH" && path.startsWith("pulls/")) {
    const pull = pulls.find((row) => row.repo === repo && row.number === Number(path.slice("pulls/".length)))!;
    Object.assign(pull, await req.json());
    return Response.json({ number: pull.number, html_url: `https://github.com/${repo}/pull/${pull.number}`, head: { sha: "patched-head" } });
  }
  return new Response(null, { status: 404 });
}

/** Bitbucket Data Center over the same files, its head always `head`. */
async function bitbucket(path: string): Promise<Response> {
  const url = new URL(path, "https://bitbucket.example");
  const [, , , , , project, , slug, kind, ...rest] = url.pathname.split("/");
  const repo = `${project}/${slug}`;
  const file = files.get(`${repo}@main/${decodeURIComponent(rest.join("/")) || url.searchParams.get("path")}`);
  if (kind === undefined) return Response.json({ links: { self: [{ href: `https://bitbucket.example/projects/${project}/repos/${slug}/browse` }] } });
  if (kind === "branches") return Response.json({ latestCommit: "head" });
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
  await runArtifactMigrations(config, { schema: "public" });
  handle = createDB(config);
  const db = handle.db;
  const cipher = createEnvKeyCredentialCipher(new Uint8Array(32).fill(7));
  const repos = [...[FROM_FILE, SAVED, EXPORTED, STARTER].map((name) => ({ name, connected: true, enabled: true, installationId: 1 })), { name: OFF, connected: true, enabled: false, installationId: 1 }, { name: SHARED, connected: true, enabled: false, installationId: 1 }, { name: CHOSEN, connected: true, enabled: false, installationId: 1 }, { name: CHOSEN_SAVED, connected: true, enabled: false, installationId: 1 }, { name: CHOSEN_RACED, connected: true, enabled: false, installationId: 1 }, { name: EXTENDS, connected: true, enabled: true, installationId: 1 }, { name: BOTH, connected: true, enabled: true, installationId: 1 }, { name: BOTH, source: "bitbucket-datacenter", connected: true, enabled: true }, { name: UNHEARD, connected: true, enabled: true, installationId: 1 }, { name: BITBUCKET_UNHEARD, source: "bitbucket-datacenter", connected: true, enabled: true }];
  await db.insert(schema.tenant).values({ id: TENANT, name: "Policy file", slug: "policy-file", domain: "policy-file.test", config: { corbitsTriage: { repos } } });
  await db.insert(schema.principal).values([
    { id: "prn_user", tenantId: TENANT, kind: "user", refId: "usr_user", status: "active" },
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
    return (resource === "credential:crd_github" || resource === "credential:crd_bb") && action === "use" && principalId === "prn_user";
  }
  const list = createTenantOpenPrs({ db, cipher, onKeyMoved: noKeyPush, githubApiOrigin, tenantBitbucket: async () => undefined });
  policyFile = createPolicyFile({
    db,
    openPulls: createMemberOpenPulls({ db, cipher, onKeyMoved: noKeyPush, authorize, list, cache: createOpenPullsCache(() => new Date()) }),
    changed() {},
    settle: settled,
    refusal: refused,
    cipher,
    onKeyMoved: noKeyPush,
    tenantBitbucket: async () => bitbucket,
    authorize,
    tenantGithub: createTenantGithub({ db, cipher, onKeyMoved: noKeyPush, githubApiOrigin }),
    log() {},
    quiet: activity.quiet,
  });
}, 120_000);

afterAll(async () => {
  server.stop(true);
  await handle?.close();
  await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
  await admin.close();
});

function settled(tenantId: string, repo: string, source: RepoSource) {
  return settlePolicy({ db: handle.db, artifacts: handle.db, async automaticKinds() { return []; }, log() {}, policyFile: policyFile.current }, tenantId, repo, source);
}

function refused(tenantId: string, repo: string, source: RepoSource, policy: Record<string, unknown>) {
  return fileRefusal({ db: handle.db, artifacts: handle.db, async automaticKinds() { return []; }, log() {}, policyFile: policyFile.current }, tenantId, repo, source, policy);
}

async function readPack(repo: string) {
  return (await settled(TENANT, repo, "github")).read;
}

async function upgrades(): Promise<Array<Record<string, unknown>>> {
  return ((await (await policyFile.upgradesRoute(MEMBER)).json()) as { repos: Array<Record<string, unknown>> }).repos;
}

async function upgradeOf(repo: string): Promise<Record<string, unknown> | undefined> {
  return (await upgrades()).find((row) => row.repo === repo);
}

async function exportOf(repo: string, text?: string): Promise<Record<string, unknown>> {
  const res = await policyFile.exportRoute({ repo, ...(text !== undefined && { text }) }, MEMBER);
  return { http: res.status, ...(await res.json() as Record<string, unknown>) };
}

async function fileOf(repo: string): Promise<unknown> {
  const res = await policyFile.fileRoute({ repo }, MEMBER);
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
  expect(await fileOf(FROM_FILE)).toEqual({ path: YML, sha: "blob1", url: `https://github.com/${FROM_FILE}/blob/main/${YML}` });
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

test("PostgreSQL: saved rules apply while the file runs differently or is refused, and are archived once the file runs the same", async () => {
  const saved: CheckPack = { ...emptyPack(SAVED), checks: { "no-forbidden-paths": { enabled: true, forbiddenGlobs: ["vendor/**", "node_modules/**"] } }, actions: { ...emptyPack(SAVED).actions, unsure: [] } };
  await writePolicy(SAVED, JSON.stringify(saved));
  const stored = await readPack(SAVED);
  expect(stored).toMatchObject({ status: "ok", source: { repo: { version: 1 } } });
  expect(await upgradeOf(SAVED)).toEqual({ repo: SAVED, source: "github", upgrade: { state: "upgrade", saved: { id: expect.any(String), version: 1 }, unexpressed: [] } });

  onMain(SAVED, YAML, "checks:\n  no-forbidden-paths: { enabled: true, forbiddenGlobs: [node_modules/**] }\n");
  await policyFile.onPush(TENANT, SAVED, "github");
  expect(await readPack(SAVED)).toEqual(stored);
  expect(await upgradeOf(SAVED)).toMatchObject({ upgrade: { state: "differs", path: YAML, differences: [{ rule: "Never accept changes to", saved: ["vendor/**", "node_modules/**"], file: ["node_modules/**"] }], fixable: true } });

  onMain(SAVED, YAML, "rules: [");
  await policyFile.onPush(TENANT, SAVED, "github");
  expect(await readPack(SAVED)).toEqual(stored);
  expect(await upgradeOf(SAVED)).toMatchObject({ upgrade: { state: "differs", differences: [], problem: "Line 1: The policy file is not YAML: Flow sequence in block collection must be sufficiently indented and end with a ]." } });

  onMain(SAVED, YAML, "checks:\n  no-forbidden-paths: { enabled: true, forbiddenGlobs: [node_modules/**, vendor/**] }\n");
  await policyFile.onPush(TENANT, SAVED, "github");
  expect(await readPack(SAVED)).toMatchObject({ status: "ok", source: { file: { path: YAML } } });
  expect(await findArtifactByTitle(handle.db, TENANT, checkPackName(SAVED, "github"))).toBeNull();
  expect(await upgradeOf(SAVED)).toEqual({ repo: SAVED, source: "github", upgrade: { state: "ok" } });

  // With the saved rules gone, an edit to the file is the policy.
  onMain(SAVED, YAML, "checks:\n  ci-green: { enabled: true }\n");
  await policyFile.onPush(TENANT, SAVED, "github");
  expect(await readPack(SAVED)).toMatchObject({ status: "ok", pack: { checks: { "ci-green": { enabled: true } } } });
}, 60_000);

test("PostgreSQL: writing the saved rules to the file opens one pull request, updates it when asked again, and the merged file takes over", async () => {
  const saved: CheckPack = { ...emptyPack(EXPORTED), checks: { "ci-green": { enabled: true } }, actions: { ...emptyPack(EXPORTED).actions, pass: [{ do: "approve", when: { author: ["OWNER", "MEMBER", "COLLABORATOR"] } }] } };
  await writePolicy(EXPORTED, JSON.stringify(saved));

  const number = pulls.length + 1;
  expect(await exportOf(EXPORTED)).toEqual({ http: 200, status: "opened", url: `https://github.com/${EXPORTED}/pull/${number}`, number, headSha: "head-sha" });
  const [pull] = pulls.filter((row) => row.repo === EXPORTED);
  expect(pull).toMatchObject({ head: POLICY_BRANCH, base: "main", body: expect.stringContaining("The saved rules keep applying until this pull request is merged.") });
  const written = files.get(`${EXPORTED}@${POLICY_BRANCH}/${YML}`)!.text!;
  expect(written).toContain("author:\n          - maintainers");
  expect(written).not.toMatch(/https?:\/\//);
  expect(policyDifferences(saved, readPolicyFile(written, EXPORTED) as CheckPack)).toEqual([]);
  expect(await upgradeOf(EXPORTED)).toMatchObject({ upgrade: { state: "upgrade" }, pull: { number: pull!.number } });

  // Asking again, after the saved rules changed, updates the same pull request.
  await writePolicy(EXPORTED, JSON.stringify({ ...saved, checks: { ...saved.checks, focused: { enabled: true } } }));
  expect(await exportOf(EXPORTED)).toMatchObject({ http: 200, number: pull!.number, headSha: files.get(`${EXPORTED}@${POLICY_BRANCH}/${YML}`)!.sha.replace("blob", "commit") });
  expect(pulls.filter((row) => row.repo === EXPORTED)).toHaveLength(1);
  expect(files.get(`${EXPORTED}@${POLICY_BRANCH}/${YML}`)!.text).toContain("check: focused");
  // Nothing new to commit: the head is GitHub's answer to the update.
  expect(await exportOf(EXPORTED)).toMatchObject({ http: 200, number: pull!.number, headSha: "patched-head" });

  // Merged: the file lands on the default branch and runs the same, so it is the policy and the saved rules retire.
  onMain(EXPORTED, YML, files.get(`${EXPORTED}@${POLICY_BRANCH}/${YML}`)!.text);
  pull!.open = false;
  await policyFile.onPush(TENANT, EXPORTED, "github");
  expect(await readPack(EXPORTED)).toMatchObject({ status: "ok", source: { file: { path: YML } } });
  expect(await upgradeOf(EXPORTED)).toEqual({ repo: EXPORTED, source: "github", upgrade: { state: "ok" } });
  expect(await exportOf(EXPORTED)).toMatchObject({ http: 409 });
}, 60_000);

test("PostgreSQL: a file already holding all a file can of the saved rules is not offered a pull request that would change nothing", async () => {
  const saved: CheckPack = {
    ...emptyPack(FROM_FILE),
    checks: { "ci-green": { enabled: true } },
    custom: [{ id: "risk", name: "Risk", group: "pull-request", kind: "model", shape: "score", subject: "the risk", levels: ["high", "low"] }],
  };
  await writePolicy(FROM_FILE, JSON.stringify(saved));
  onMain(FROM_FILE, YML, exportPolicyFile(saved, false).text);
  await policyFile.onPush(TENANT, FROM_FILE, "github");
  expect(await readPack(FROM_FILE)).toMatchObject({ status: "ok", source: { repo: { version: 1 } } });
  expect(await upgradeOf(FROM_FILE)).toMatchObject({ upgrade: { state: "differs", differences: [{ rule: "Risk", file: [] }], fixable: false } });
  expect(await exportOf(FROM_FILE)).toMatchObject({ http: 409, error: { code: "policy_file_full" } });
}, 60_000);

test("PostgreSQL: an enabled repository with no rules and no file is offered a starter file through the same pull request, left as edited and run once merged", async () => {
  expect(await upgradeOf(STARTER)).toEqual({ repo: STARTER, source: "github", upgrade: { state: "start" } });
  expect(await exportOf(OFF)).toMatchObject({ http: 409, error: { code: "policy_settled" } });

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
  expect(read.status === "ok" && policyDifferences(starterPack(STARTER), read.pack)).toMatchObject([{ rule: "Most files changed", saved: ["30", "on fail, labels size: large"], file: ["40", "on fail, labels size: large"] }]);
  expect(await upgradeOf(STARTER)).toEqual({ repo: STARTER, source: "github", upgrade: { state: "ok" } });
  expect(await exportOf(STARTER)).toMatchObject({ http: 409, error: { code: "policy_settled" } });
}, 60_000);

test("PostgreSQL: a file chosen for a repository with no file, saved rules or open pull request is opened as triage would run it, and the open pull request is left as it is", async () => {
  expect(await exportOf(CHOSEN, "rules: [")).toMatchObject({ http: 422, error: { code: "policy_file_invalid", message: expect.stringContaining("Line 1: The policy file is not YAML") } });
  expect(await exportOf(CHOSEN, "extends: acme/nowhere\nchecks: {}\n")).toMatchObject({ http: 422, error: { code: "policy_file_invalid", message: "acme/nowhere is not connected to this workspace or has no policy file." } });
  await writePolicy(CHOSEN_SAVED, JSON.stringify(starterPack(CHOSEN_SAVED)));
  expect(await exportOf(CHOSEN_SAVED, FILE)).toMatchObject({ http: 409, error: { code: "saved_rules" } });
  expect(pulls.filter((row) => row.repo === CHOSEN || row.repo === CHOSEN_SAVED)).toEqual([]);

  const number = pulls.length + 1;
  const url = `https://github.com/${CHOSEN}/pull/${number}`;
  expect(await exportOf(CHOSEN, FILE)).toEqual({ http: 200, status: "opened", url, number, headSha: "head-sha" });
  expect(pulls.filter((row) => row.repo === CHOSEN)).toMatchObject([{ head: POLICY_BRANCH, base: "main", title: `chore: add a Corbits Triage policy in ${YML}` }]);
  expect(files.get(`${CHOSEN}@${POLICY_BRANCH}/${YML}`)!.text).toBe(FILE);

  expect(await exportOf(CHOSEN, FILE.replace("CI passes.", "CI is green."))).toMatchObject({ http: 409, error: { code: "policy_pull_open", url, number } });
  expect(files.get(`${CHOSEN}@${POLICY_BRANCH}/${YML}`)!.text).toBe(FILE);

  // Merged where no push is heard, the file is still found.
  onMain(CHOSEN, YML, FILE);
  pulls.find((row) => row.repo === CHOSEN)!.open = false;
  expect(await exportOf(CHOSEN, FILE)).toMatchObject({ http: 409, error: { code: "policy_file_present" } });

  // Another caller opening it between the check and the create is answered with theirs.
  const theirs = pulls.length + 1;
  raced = { repo: CHOSEN_RACED, number: theirs, head: POLICY_BRANCH, base: "main", title: "theirs", body: "", open: true };
  expect(await exportOf(CHOSEN_RACED, FILE)).toMatchObject({ http: 200, number: theirs });
  expect(pulls.filter((row) => row.repo === CHOSEN_RACED)).toHaveLength(1);
}, 60_000);

async function writePolicy(repo: string, content: string): Promise<void> {
  await handle.db.transaction(function createPolicy(tx) {
    return createArtifact(tx, { scope: { tenantId: TENANT, principalId: "prn_user" }, ownerPrincipalId: null, kind: "document", title: checkPackName(repo, "github"), content, source: { origin: "manual" } });
  });
}

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
  async function readOf(repo: string, source: RepoSource) {
    return (await settled(TENANT, repo, source)).read;
  }
  try {
    for (const [repo, source] of [[UNHEARD, "github"], [BITBUCKET_UNHEARD, "bitbucket-datacenter"]] as const) {
      after(0);
      expect(await readOf(repo, source)).toEqual({ status: "missing" });
      onMain(repo, YML, FILE, `${source}1`);
      after(61_000);
      expect(await readOf(repo, source)).toMatchObject({ status: "ok", source: { file: { sha: `${source}1` } } });
      activity.heard(TENANT, source, repo);
      onMain(repo, YML, FILE, `${source}2`);
      after(122_000);
      expect(await readOf(repo, source)).toMatchObject({ status: "ok", source: { file: { sha: `${source}1` } } });
      after(61_000 + 30 * 60_000);
      expect(await readOf(repo, source)).toMatchObject({ status: "ok", source: { file: { sha: `${source}2` } } });
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
