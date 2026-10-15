// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { createArtifact, runArtifactMigrations, writeArtifactVersion } from "@corbits/artifacts";
import { checkPackName, emptyPack, readPolicyFile } from "@corbits/triage-contracts";
import { loadCheckPack, repoPolicyRow } from "./check-pack-store.js";
import { createPolicyFile, EXPORT_BRANCH } from "./policy-file.js";
import { createTenantGithub } from "./tenant-open-heads.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_policy_file";
const SYNCED = "acme/synced";
const EXPORTED = "acme/exported";
const MEMBER = { tenantId: TENANT, principalId: "prn_user" };
const VIEWER = { tenantId: TENANT, principalId: "prn_viewer" };
const FILE = `checks:
  ci-green:
    enabled: true
actions:
  when: [opened]
  pass: []
  fail: []
  unsure: []
`;

/** A null `text` is a file over 1 MB, whose content GitHub leaves out; the sha `DIRECTORY` is a directory at the path. */
const DIRECTORY = "directory";
const files = new Map<string, { sha: string; text: string | null }>();
const branches = new Set<string>();
const opened: Array<{ head: string; base: string; title: string }> = [];
const committed: Array<{ branch: string; text: string }> = [];
let commitFails = false;

async function github(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === "/app/installations/1/access_tokens") return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  const [, , owner, name, ...rest] = pathname.split("/");
  const repo = `${owner}/${name}`;
  const path = rest.join("/");
  if (req.method === "GET" && path === "contents/.corbits-triage.yaml") {
    const file = files.get(repo);
    if (!file) return new Response(null, { status: 404 });
    if (file.sha === DIRECTORY) return Response.json([{ type: "file", name: "inner.yaml" }]);
    const content = file.text === null ? { content: "", encoding: "none" } : { content: Buffer.from(file.text).toString("base64"), encoding: "base64" };
    return Response.json({ type: "file", sha: file.sha, ...content, html_url: `https://github.com/${repo}/blob/main/.corbits-triage.yaml` });
  }
  if (req.method === "DELETE" && path.startsWith("git/refs/heads/")) {
    branches.delete(`${repo}:refs/heads/${path.slice("git/refs/heads/".length)}`);
    return new Response(null, { status: 204 });
  }
  if (req.method === "GET" && path === "") return Response.json({ default_branch: "main" });
  if (req.method === "GET" && path === "git/ref/heads/main") return Response.json({ object: { sha: "main-sha" } });
  if (req.method === "POST" && path === "git/refs") {
    const { ref } = await req.json() as { ref: string };
    if (branches.has(`${repo}:${ref}`)) return Response.json({ message: "Reference already exists" }, { status: 422 });
    branches.add(`${repo}:${ref}`);
    return Response.json({ ref }, { status: 201 });
  }
  if (req.method === "PUT" && path === "contents/.corbits-triage.yaml") {
    if (commitFails) return Response.json({ message: "Server Error" }, { status: 500 });
    const { branch, content } = await req.json() as { branch: string; content: string };
    committed.push({ branch, text: Buffer.from(content, "base64").toString("utf8") });
    return Response.json({ content: { sha: "blob-exported" } }, { status: 201 });
  }
  if (req.method === "POST" && path === "pulls") {
    opened.push(await req.json() as (typeof opened)[number]);
    return Response.json({ number: 12, html_url: `https://github.com/${repo}/pull/12` }, { status: 201 });
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
  const repos = [SYNCED, EXPORTED].map((name) => ({ name, connected: true, enabled: true, installationId: 1 }));
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
  policyFile = createPolicyFile({
    db,
    artifacts: db,
    cipher,
    tenantBitbucket: async () => undefined,
    async authorize(principalId, _tenantId, resource, action) {
      if (resource === "credential:crd_github") return action === "use" && ["prn_user", "prn_viewer"].includes(principalId);
      return principalId === "prn_user" && ((resource === "artifact:*" && action === "create") || (resource.startsWith("artifact:") && action === "write"));
    },
    tenantGithub: createTenantGithub({ db, cipher, githubApiOrigin }),
    async writerFor() {
      return "prn_github";
    },
    async grantWriters() {},
    now: () => new Date("2026-10-13T12:00:00Z"),
    log() {},
  });
}, 120_000);

afterAll(async () => {
  server.stop(true);
  await handle?.close();
  await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
  await admin.close();
});

function readPack(tenantId: string, repo: string) {
  return loadCheckPack({ db: handle.db, artifacts: handle.db, async automaticKinds() { return []; }, log() {} }, tenantId, repo);
}

async function fileOf(repo: string): Promise<unknown> {
  const res = await policyFile.fileRoute({ repo }, MEMBER);
  return ((await res.json()) as { file: unknown }).file;
}

async function latestAuthor(artifactId: string): Promise<unknown> {
  const [row] = await handle.db.execute(sql`select author_id from artifacts.artifact_version where artifact_id = ${artifactId} order by version desc limit 1`);
  return (row as { author_id: unknown } | undefined)?.author_id;
}

async function syncedRow() {
  return (await repoPolicyRow({ db: handle.db, artifacts: handle.db }, TENANT, SYNCED))!;
}

/** Each level holds eight of the one before, so ten levels expand to a billion strings once serialised. */
function aliasBomb(): string {
  const levels = Array.from({ length: 10 }, (_, i) => `l${i + 1}: &l${i + 1} [${Array(8).fill(i === 0 ? '"x"' : `*l${i}`).join(", ")}]`);
  return `checks: {}\nbomb:\n${levels.map((line) => `  ${line}`).join("\n")}\n`;
}

test("PostgreSQL: syncing stores the policy file as the repository's policy, marked with its sha, until the hub's copy changes", async () => {
  expect(await fileOf(SYNCED)).toBeNull();
  expect((await policyFile.syncRoute({ repo: SYNCED }, MEMBER)).status).toBe(404);

  files.set(SYNCED, { sha: "blob1", text: FILE });
  // Using the file writes the policy, which credential `use` alone does not allow.
  expect((await policyFile.syncRoute({ repo: SYNCED }, VIEWER)).status).toBe(403);
  const first = await policyFile.syncRoute({ repo: SYNCED }, MEMBER);
  expect(await first.json()).toEqual({ status: "synced", sha: "blob1" });
  const read = await readPack(TENANT, SYNCED);
  expect(read).toMatchObject({ status: "ok", source: { repo: { version: 1 }, file: { path: ".corbits-triage.yaml", sha: "blob1" } } });
  expect(read.status === "ok" && read.pack.checks).toEqual({ "ci-green": { enabled: true } });
  expect(await latestAuthor((await syncedRow()).id)).toBe("prn_github");
  expect((await policyFile.syncRoute({ repo: SYNCED }, VIEWER)).status).toBe(403);
  expect(await fileOf(SYNCED)).toEqual({ path: ".corbits-triage.yaml", sha: "blob1", url: "https://github.com/acme/synced/blob/main/.corbits-triage.yaml", syncedAt: "2026-10-13T12:00:00.000Z", inSync: true });
  expect(await (await policyFile.syncRoute({ repo: SYNCED }, MEMBER)).json()).toEqual({ status: "unchanged", sha: "blob1" });

  // The same policy with its keys in another order is still the file's.
  const row = await syncedRow();
  const reordered = Object.fromEntries(Object.entries(JSON.parse(row.content) as Record<string, unknown>).reverse());
  await writeArtifactVersion(handle.db, { scope: { tenantId: TENANT, principalId: "prn_user" }, artifactId: row.id, content: JSON.stringify(reordered) });
  expect(await fileOf(SYNCED)).toMatchObject({ inSync: true });

  // A save from the portal carries the marker's metadata forward; the content no longer matches it.
  await writeArtifactVersion(handle.db, { scope: { tenantId: TENANT, principalId: "prn_user" }, artifactId: row.id, content: JSON.stringify(emptyPack(SYNCED)) });
  const edited = await readPack(TENANT, SYNCED);
  expect(edited.status === "ok" && edited.source.file).toBeUndefined();
  expect(await fileOf(SYNCED)).toMatchObject({ sha: "blob1", inSync: false });

  expect(await policyFile.onPush(TENANT, SYNCED, false)).toEqual({ status: "synced", sha: "blob1" });

  const manyKeys = Array.from({ length: 7 }, (_, i) => `k${i}: 1`).join("\n");
  const refused: Array<[string | null, string]> = [
    ["checks: [", "is not YAML: unexpected end of the stream within a flow collection at line 2, column 1."],
    [`${FILE}${manyKeys}\n`, "unknown keys: k0, k1, k2, k3, k4 and 2 more."],
    ["checks:\n  ci-gren:\n    enabled: true\n", "unknown checks: ci-gren."],
    [DIRECTORY, "is not a file"],
    [aliasBomb(), "too large or uses aliases"],
    [`checks: {}\n#${"x".repeat(70 * 1024)}\n`, "too large or uses aliases"],
    [null, "too large or uses aliases"],
  ];
  for (const [i, [text, reason]] of refused.entries()) {
    files.set(SYNCED, text === DIRECTORY ? { sha: DIRECTORY, text: null } : { sha: `bad${i}`, text });
    const started = performance.now();
    const res = await policyFile.syncRoute({ repo: SYNCED }, MEMBER);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { message: expect.stringContaining(reason) } });
    expect(performance.now() - started).toBeLessThan(2_000);
    if (text === DIRECTORY) {
      const status = await policyFile.fileRoute({ repo: SYNCED }, MEMBER);
      expect(status.status).toBe(422);
      continue;
    }
    expect(await fileOf(SYNCED)).toMatchObject({ sha: `bad${i}`, inSync: false, problem: expect.stringContaining(reason) });
  }

  // A file not found on a push that did not remove it writes nothing; one that removed it ends the marker.
  files.set(SYNCED, { sha: "blob1", text: FILE });
  await policyFile.onPush(TENANT, SYNCED, false);
  const before = await syncedRow();
  files.delete(SYNCED);
  expect(await policyFile.onPush(TENANT, SYNCED, false)).toEqual({ status: "absent" });
  expect((await syncedRow()).version).toBe(before.version);
  expect(await policyFile.onPush(TENANT, SYNCED, true)).toEqual({ status: "removed" });
  const after = await readPack(TENANT, SYNCED);
  expect(after.status === "ok" && after.source.file).toBeUndefined();
  expect((await syncedRow()).content).toBe(before.content);

  expect((await policyFile.syncRoute({ repo: SYNCED }, { tenantId: TENANT, principalId: "prn_github" })).status).toBe(403);
}, 60_000);

test("PostgreSQL: exporting opens one pull request adding the file the hub's policy reads back as, and takes back its branch when it fails", async () => {
  expect((await policyFile.exportRoute({ repo: EXPORTED }, MEMBER)).status).toBe(409);
  const pack = { ...emptyPack(EXPORTED), checks: { "ci-green": { enabled: true } } };
  await writePolicy(EXPORTED, JSON.stringify(pack));

  commitFails = true;
  expect((await policyFile.exportRoute({ repo: EXPORTED }, MEMBER)).status).toBe(502);
  expect(branches.has(`${EXPORTED}:refs/heads/${EXPORT_BRANCH}`)).toBe(false);
  commitFails = false;

  const res = await policyFile.exportRoute({ repo: EXPORTED }, MEMBER);
  expect(await res.json()).toEqual({ status: "opened", url: "https://github.com/acme/exported/pull/12", number: 12 });
  expect(opened).toEqual([expect.objectContaining({ head: EXPORT_BRANCH, base: "main" })]);
  expect(committed).toHaveLength(1);
  expect(committed[0]!.branch).toBe(EXPORT_BRANCH);
  expect(committed[0]!.text.startsWith("# Corbits Triage policy.\n")).toBe(true);
  expect(committed[0]!.text).not.toMatch(/https?:\/\//);
  expect(readPolicyFile(committed[0]!.text, EXPORTED)).toEqual(JSON.parse(JSON.stringify(pack)));

  const again = await policyFile.exportRoute({ repo: EXPORTED }, MEMBER);
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ error: { code: "policy_branch_exists" } });
}, 60_000);

async function writePolicy(repo: string, content: string): Promise<void> {
  await handle.db.transaction(function createPolicy(tx) {
    return createArtifact(tx, { scope: { tenantId: TENANT, principalId: "prn_user" }, ownerPrincipalId: null, kind: "document", title: checkPackName(repo), content, source: { origin: "manual" } });
  });
}
