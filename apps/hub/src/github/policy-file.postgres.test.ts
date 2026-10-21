// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { createArtifact, findArtifactByTitle, runArtifactMigrations } from "@corbits/artifacts";
import { checkPackName, emptyPack, exportPolicyFile, policyDifferences, readPolicyFile, starterPack, type CheckPack } from "@corbits/triage-contracts";
import { fileRefusal, settlePolicy } from "./check-pack-store.js";
import { createPolicyFile } from "./policy-file.js";
import { POLICY_BRANCH } from "./policy-pull.js";
import { createMemberOpenPulls, createOpenPullsCache } from "./open-pulls.js";
import { createTenantGithub, createTenantOpenPrs } from "./tenant-open-heads.js";

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
    return Response.json({ content: { sha: `blob${commits}` } }, { status: 201 });
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
    return Response.json(pulls.filter((pull) => pull.repo === repo && pull.open && `${owner}:${pull.head}` === head).map((pull) => ({ number: pull.number, html_url: `https://github.com/${repo}/pull/${pull.number}` })));
  }
  if (req.method === "POST" && path === "pulls") {
    const body = await req.json() as { head: string; base: string; title: string; body: string };
    if (pulls.some((pull) => pull.repo === repo && pull.open && pull.head === body.head && pull.base === body.base)) return Response.json({ message: "Validation Failed" }, { status: 422 });
    pulls.push({ repo, number: pulls.length + 1, open: true, ...body });
    return Response.json({ number: pulls.length, html_url: `https://github.com/${repo}/pull/${pulls.length}` }, { status: 201 });
  }
  if (req.method === "PATCH" && path.startsWith("pulls/")) {
    const pull = pulls.find((row) => row.repo === repo && row.number === Number(path.slice("pulls/".length)))!;
    Object.assign(pull, await req.json());
    return Response.json({ number: pull.number });
  }
  return new Response(null, { status: 404 });
}

const server = Bun.serve({ port: 0, fetch: github });
const githubApiOrigin = `http://127.0.0.1:${server.port}`;
const database = `corbits_policy_file_${randomBytes(6).toString("hex")}`;
const config = { ...TEST_DB, database };
const admin = createDB(TEST_DB);
let handle: ReturnType<typeof createDB>;
let policyFile: ReturnType<typeof createPolicyFile>;

beforeAll(async () => {
  await admin.db.execute(sql.raw(`create database ${database}`));
  await runMigrations(config, { schema: "public" });
  await runArtifactMigrations(config, { schema: "public" });
  handle = createDB(config);
  const db = handle.db;
  const cipher = createEnvKeyCredentialCipher(new Uint8Array(32).fill(7));
  const repos = [...[FROM_FILE, SAVED, EXPORTED, STARTER].map((name) => ({ name, connected: true, enabled: true, installationId: 1 })), { name: OFF, connected: true, enabled: false, installationId: 1 }, { name: SHARED, connected: true, enabled: false, installationId: 1 }, { name: CHOSEN, connected: true, enabled: false, installationId: 1 }, { name: CHOSEN_SAVED, connected: true, enabled: false, installationId: 1 }, { name: CHOSEN_RACED, connected: true, enabled: false, installationId: 1 }, { name: EXTENDS, connected: true, enabled: true, installationId: 1 }];
  await db.insert(schema.tenant).values({ id: TENANT, name: "Policy file", slug: "policy-file", domain: "policy-file.test", config: { corbitsTriage: { repos } } });
  await db.insert(schema.principal).values([
    { id: "prn_user", tenantId: TENANT, kind: "user", refId: "usr_user", status: "active" },
    { id: "prn_github", tenantId: TENANT, kind: "user", refId: "github", status: "active" },
  ]);
  await db.insert(schema.provider).values({ id: "prv_github", tenantId: TENANT, name: "github", plugin: "http", apiBaseUrl: githubApiOrigin });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  await db.insert(schema.credential).values({
    id: "crd_github", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key",
    secret: await cipher.encrypt(JSON.stringify({ appId: "1", privateKey }), credentialAad("crd_github", "secret")), status: "active",
  });
  async function authorize(principalId: string, _tenantId: string, resource: string, action: string) {
    return resource === "credential:crd_github" && action === "use" && principalId === "prn_user";
  }
  const list = createTenantOpenPrs({ db, cipher, githubApiOrigin, tenantBitbucket: async () => undefined });
  policyFile = createPolicyFile({
    db,
    openPulls: createMemberOpenPulls({ db, cipher, authorize, list, cache: createOpenPullsCache(() => new Date()) }),
    settle: settled,
    refusal: refused,
    cipher,
    tenantBitbucket: async () => undefined,
    authorize,
    tenantGithub: createTenantGithub({ db, cipher, githubApiOrigin }),
    log() {},
  });
}, 120_000);

afterAll(async () => {
  server.stop(true);
  await handle?.close();
  await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
  await admin.close();
});

function settled(tenantId: string, repo: string) {
  return settlePolicy({ db: handle.db, artifacts: handle.db, async automaticKinds() { return []; }, log() {}, policyFile: policyFile.current }, tenantId, repo);
}

function refused(tenantId: string, repo: string, policy: Record<string, unknown>) {
  return fileRefusal({ db: handle.db, artifacts: handle.db, async automaticKinds() { return []; }, log() {}, policyFile: policyFile.current }, tenantId, repo, policy);
}

async function readPack(repo: string) {
  return (await settled(TENANT, repo)).read;
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
  expect(await policyFile.onPush(TENANT, FROM_FILE)).toMatchObject({ status: "ok", file: { path: YML, sha: "blob1" } });
  const read = await readPack(FROM_FILE);
  expect(read).toEqual({ status: "ok", pack: expect.anything(), automatic: [], source: { file: { path: YML, sha: "blob1" } } });
  expect(read.status === "ok" && read.pack.checks).toEqual({ "ci-green": { enabled: true, text: "CI passes.", reason: "Required by branch protection.", evidence: ["maintainer-stated"] } });
  expect(await fileOf(FROM_FILE)).toEqual({ path: YML, sha: "blob1", url: `https://github.com/${FROM_FILE}/blob/main/${YML}` });
  expect(await upgradeOf(FROM_FILE)).toEqual({ repo: FROM_FILE, upgrade: { state: "ok" } });

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
    await policyFile.onPush(TENANT, FROM_FILE);
    expect(await readPack(FROM_FILE)).toEqual({ status: "invalid", path: YML, reason: expect.stringContaining(reason) });
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
  await policyFile.onPush(TENANT, FROM_FILE);
  expect(await readPack(FROM_FILE)).toMatchObject({ status: "ok", source: { file: { path: YAML, sha: "blob2" } } });

  // A push whose read fails keeps nothing, so the next trigger reads the file itself.
  files.delete(`${FROM_FILE}@main/${YAML}`);
  readFails = true;
  await expect(policyFile.onPush(TENANT, FROM_FILE)).rejects.toThrow("502");
  readFails = false;
  expect(await readPack(FROM_FILE)).toEqual({ status: "missing" });
}, 60_000);

test("PostgreSQL: saved rules apply while the file runs differently or is refused, and are archived once the file runs the same", async () => {
  const saved: CheckPack = { ...emptyPack(SAVED), checks: { "no-forbidden-paths": { enabled: true, forbiddenGlobs: ["vendor/**", "node_modules/**"] } }, actions: { ...emptyPack(SAVED).actions, unsure: [] } };
  await writePolicy(SAVED, JSON.stringify(saved));
  const stored = await readPack(SAVED);
  expect(stored).toMatchObject({ status: "ok", source: { repo: { version: 1 } } });
  expect(await upgradeOf(SAVED)).toEqual({ repo: SAVED, upgrade: { state: "upgrade", saved: { id: expect.any(String), version: 1 }, unexpressed: [] } });

  onMain(SAVED, YAML, "checks:\n  no-forbidden-paths: { enabled: true, forbiddenGlobs: [node_modules/**] }\n");
  await policyFile.onPush(TENANT, SAVED);
  expect(await readPack(SAVED)).toEqual(stored);
  expect(await upgradeOf(SAVED)).toMatchObject({ upgrade: { state: "differs", path: YAML, differences: [{ rule: "Never accept changes to", saved: ["vendor/**", "node_modules/**"], file: ["node_modules/**"] }], fixable: true } });

  onMain(SAVED, YAML, "rules: [");
  await policyFile.onPush(TENANT, SAVED);
  expect(await readPack(SAVED)).toEqual(stored);
  expect(await upgradeOf(SAVED)).toMatchObject({ upgrade: { state: "differs", differences: [], problem: "Line 1: The policy file is not YAML: Flow sequence in block collection must be sufficiently indented and end with a ]." } });

  onMain(SAVED, YAML, "checks:\n  no-forbidden-paths: { enabled: true, forbiddenGlobs: [node_modules/**, vendor/**] }\n");
  await policyFile.onPush(TENANT, SAVED);
  expect(await readPack(SAVED)).toMatchObject({ status: "ok", source: { file: { path: YAML } } });
  expect(await findArtifactByTitle(handle.db, TENANT, checkPackName(SAVED))).toBeNull();
  expect(await upgradeOf(SAVED)).toEqual({ repo: SAVED, upgrade: { state: "ok" } });

  // With the saved rules gone, an edit to the file is the policy.
  onMain(SAVED, YAML, "checks:\n  ci-green: { enabled: true }\n");
  await policyFile.onPush(TENANT, SAVED);
  expect(await readPack(SAVED)).toMatchObject({ status: "ok", pack: { checks: { "ci-green": { enabled: true } } } });
}, 60_000);

test("PostgreSQL: writing the saved rules to the file opens one pull request, updates it when asked again, and the merged file takes over", async () => {
  const saved: CheckPack = { ...emptyPack(EXPORTED), checks: { "ci-green": { enabled: true } }, actions: { ...emptyPack(EXPORTED).actions, pass: [{ do: "approve", when: { author: ["OWNER", "MEMBER", "COLLABORATOR"] } }] } };
  await writePolicy(EXPORTED, JSON.stringify(saved));

  const number = pulls.length + 1;
  expect(await exportOf(EXPORTED)).toEqual({ http: 200, status: "opened", url: `https://github.com/${EXPORTED}/pull/${number}`, number });
  const [pull] = pulls.filter((row) => row.repo === EXPORTED);
  expect(pull).toMatchObject({ head: POLICY_BRANCH, base: "main", body: expect.stringContaining("The saved rules keep applying until this pull request is merged.") });
  const written = files.get(`${EXPORTED}@${POLICY_BRANCH}/${YML}`)!.text!;
  expect(written).toContain("author:\n          - maintainers");
  expect(written).not.toMatch(/https?:\/\//);
  expect(policyDifferences(saved, readPolicyFile(written, EXPORTED) as CheckPack)).toEqual([]);
  expect(await upgradeOf(EXPORTED)).toMatchObject({ upgrade: { state: "upgrade" }, pull: { number: pull!.number } });

  // Asking again, after the saved rules changed, updates the same pull request.
  await writePolicy(EXPORTED, JSON.stringify({ ...saved, checks: { ...saved.checks, focused: { enabled: true } } }));
  expect(await exportOf(EXPORTED)).toMatchObject({ http: 200, number: pull!.number });
  expect(pulls.filter((row) => row.repo === EXPORTED)).toHaveLength(1);
  expect(files.get(`${EXPORTED}@${POLICY_BRANCH}/${YML}`)!.text).toContain("check: focused");

  // Merged: the file lands on the default branch and runs the same, so it is the policy and the saved rules retire.
  onMain(EXPORTED, YML, files.get(`${EXPORTED}@${POLICY_BRANCH}/${YML}`)!.text);
  pull!.open = false;
  await policyFile.onPush(TENANT, EXPORTED);
  expect(await readPack(EXPORTED)).toMatchObject({ status: "ok", source: { file: { path: YML } } });
  expect(await upgradeOf(EXPORTED)).toEqual({ repo: EXPORTED, upgrade: { state: "ok" } });
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
  await policyFile.onPush(TENANT, FROM_FILE);
  expect(await readPack(FROM_FILE)).toMatchObject({ status: "ok", source: { repo: { version: 1 } } });
  expect(await upgradeOf(FROM_FILE)).toMatchObject({ upgrade: { state: "differs", differences: [{ rule: "Risk", file: [] }], fixable: false } });
  expect(await exportOf(FROM_FILE)).toMatchObject({ http: 409, error: { code: "policy_file_full" } });
}, 60_000);

test("PostgreSQL: an enabled repository with no rules and no file is offered a starter file through the same pull request, left as edited and run once merged", async () => {
  expect(await upgradeOf(STARTER)).toEqual({ repo: STARTER, upgrade: { state: "start" } });
  expect(await exportOf(OFF)).toMatchObject({ http: 409, error: { code: "policy_settled" } });

  const number = pulls.length + 1;
  expect(await exportOf(STARTER)).toEqual({ http: 200, status: "opened", url: `https://github.com/${STARTER}/pull/${number}`, number });
  expect(pulls.filter((row) => row.repo === STARTER)).toMatchObject([{ head: POLICY_BRANCH, base: "main", title: `chore: add a Corbits Triage policy in ${YML}` }]);
  // Opening it lists the workspace's pull requests again; a reload then finds it in that listing without asking GitHub.
  requests.length = 0;
  expect(await upgradeOf(STARTER)).toEqual({ repo: STARTER, upgrade: { state: "start" }, pull: { url: `https://github.com/${STARTER}/pull/${number}`, number } });
  expect(requests.filter((request) => request.includes(STARTER))).toEqual([]);

  // Asking again answers the open pull request and keeps the maintainer's edit on its branch.
  const branchFile = `${STARTER}@${POLICY_BRANCH}/${YML}`;
  const edited = files.get(branchFile)!.text!.replace("max: 30", "max: 40");
  files.set(branchFile, { sha: "edited", text: edited });
  expect(await exportOf(STARTER)).toEqual({ http: 200, status: "opened", url: `https://github.com/${STARTER}/pull/${number}`, number });
  expect(files.get(branchFile)).toEqual({ sha: "edited", text: edited });
  expect(pulls.filter((row) => row.repo === STARTER)).toHaveLength(1);

  onMain(STARTER, YML, files.get(`${STARTER}@${POLICY_BRANCH}/${YML}`)!.text);
  pulls.find((row) => row.repo === STARTER)!.open = false;
  await policyFile.onPush(TENANT, STARTER);
  const read = await readPack(STARTER);
  expect(read).toMatchObject({ status: "ok", source: { file: { path: YML } } });
  expect(read.status === "ok" && policyDifferences(starterPack(STARTER), read.pack)).toMatchObject([{ rule: "Most files changed", saved: ["30", "on fail, labels size: large"], file: ["40", "on fail, labels size: large"] }]);
  expect(await upgradeOf(STARTER)).toEqual({ repo: STARTER, upgrade: { state: "ok" } });
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
  expect(await exportOf(CHOSEN, FILE)).toEqual({ http: 200, status: "opened", url, number });
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
    return createArtifact(tx, { scope: { tenantId: TENANT, principalId: "prn_user" }, ownerPrincipalId: null, kind: "document", title: checkPackName(repo), content, source: { origin: "manual" } });
  });
}

test("PostgreSQL: a policy file extending another repository runs over that repository's file as last pushed, and is refused while that file cannot be read or extends again", async () => {
  onMain(EXTENDS, YML, `extends: ${SHARED}\nrules:\n  - check: max-files-changed\n    max: 50\n    text: At most 50 files.\n    reason: Reviewable.\n    evidence: [maintainer-stated]\n`, "own1");
  await policyFile.onPush(TENANT, EXTENDS);
  expect(await readPack(EXTENDS)).toEqual({ status: "invalid", path: YML, reason: `${SHARED} is not connected to this workspace or has no policy file.` });

  onMain(SHARED, YML, FILE, "shared1");
  await policyFile.onPush(TENANT, SHARED);
  const read = await readPack(EXTENDS);
  expect(read).toMatchObject({ status: "ok", source: { file: { path: YML, sha: "own1" }, sharedFile: { repo: SHARED, path: YML, sha: "shared1" } } });
  expect(read.status === "ok" && Object.keys(read.pack.checks)).toEqual(["ci-green", "max-files-changed"]);

  // A push to the shared repository reaches every repository extending it.
  onMain(SHARED, YML, `extends: ${EXTENDS}\n${FILE}`, "shared2");
  await policyFile.onPush(TENANT, SHARED);
  expect(await readPack(EXTENDS)).toEqual({ status: "invalid", path: YML, reason: `${SHARED}'s policy extends another, so no policy can extend it.` });

  onMain(SHARED, YML, "rules: [", "shared3");
  await policyFile.onPush(TENANT, SHARED);
  expect(await readPack(EXTENDS)).toEqual({ status: "invalid", path: YML, reason: expect.stringContaining(`${SHARED}'s policy file is refused: Line 1: The policy file is not YAML`) });
});
