// The live chain on one machine: a migrated database of its own, the hub process with its local sidecars serving a
// portal build, and a workspace set up through the same routes and portal code a person's browser uses.
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDB, schema } from "@intx/db";
import { ApiError, type Transport } from "@intx/hub-client";
import { GITHUB_HOOK_HEADERS, xHubHookMetadata } from "@corbits/common/hook-metadata";
import { packWorkflows } from "../../apps/web/scripts/build-workflows.ts";
import { DECISION_MODEL_ALIAS, INFERENCE_PROVIDER, TRIAGE_LISTENERS } from "@corbits/triage-contracts";
import { currentDeployment, INFERENCE_CREDENTIAL_NAME, patchAppConfig, readDeployedVersions } from "../../apps/web/src/lib/hub-api.ts";
import { connectGithubApp } from "../../apps/web/src/lib/github-manifest.ts";
import type { FakeGithub } from "./github.ts";

const ROOT = resolve(import.meta.dir, "../..");
const ADMIN_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
// The hub and its sidecars shell out to bun, which needs it on PATH and a HOME for its cache.
const CHILD_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const SECRETS = {
  BETTER_AUTH_SECRET: "a".repeat(64),
  CREDENTIAL_ENCRYPTION_KEY: "b".repeat(64),
  PRINCIPAL_KEY_ENCRYPTION_KEY: "c".repeat(64),
  SIDECAR_CREDENTIAL_ENCRYPTION_KEY: "d".repeat(64),
};
export const HOOK_SECRET = "chain-hook-secret";
const READY_MS = 60_000;
const LISTENER_START_MS = 10 * 60_000;
/** The reconcile pass, short so a scenario waits on it for seconds rather than the default five minutes. */
export const RECONCILE_INTERVAL_MS = 15_000;

export type Database = { name: string; url: string; config: typeof ADMIN_DB };

export async function createDatabase(): Promise<Database> {
  const name = `corbits_chain_${randomBytes(6).toString("hex")}`;
  const admin = createDB(ADMIN_DB);
  try {
    await admin.db.execute(sql.raw(`create database ${name}`));
  } finally {
    await admin.close();
  }
  const url = `postgres://postgres:postgres@localhost:5432/${name}`;
  await Bun.$`${process.execPath} --conditions=intx-src apps/hub/src/migrate.ts`.cwd(ROOT).env({ PATH: CHILD_PATH, HOME: homedir(), DATABASE_URL: url }).quiet();
  return { name, url, config: { ...ADMIN_DB, database: name } };
}

export async function dropDatabase(database: Database): Promise<void> {
  const admin = createDB(ADMIN_DB);
  try {
    await admin.db.execute(sql.raw(`drop database if exists ${database.name} with (force)`));
  } finally {
    await admin.close();
  }
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function collect(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<void> {
  const decoder = new TextDecoder();
  let partial = "";
  for await (const chunk of stream) {
    const parts = (partial + decoder.decode(chunk, { stream: true })).split("\n");
    partial = parts.pop()!;
    lines.push(...parts);
  }
}

export type Hub = { origin: string; dataDir: string; logs: string[]; stop: () => Promise<void> };

/** The hub as the image starts it, serving the portal build in `portalDir`, with its sidecar a local process under its data directory. */
export async function startHub(database: Database, github: FakeGithub, portalDir: string, env: Record<string, string> = {}): Promise<Hub> {
  const port = freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "corbits-chain-"));
  const logs: string[] = [];
  const child = Bun.spawn([process.execPath, "--conditions=intx-src", "apps/hub/src/server.ts"], {
    cwd: ROOT,
    env: {
      PATH: CHILD_PATH,
      HOME: homedir(),
      ...SECRETS,
      DATABASE_URL: database.url,
      HUB_DATA_DIR: dataDir,
      PORTAL_DIR: portalDir,
      PORT: String(port),
      BETTER_AUTH_BASE_URL: origin,
      GITHUB_API_ORIGIN: github.origin,
      TRIAGE_COALESCE_QUIET_MS: "500",
      TRIAGE_RECONCILE_INTERVAL_MS: String(RECONCILE_INTERVAL_MS),
      // Every sidecar a local process, as on a hub without Docker, so each reaches the fake GitHub and model on loopback.
      DOCKER_HOST: "unix:///nonexistent/docker.sock",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  void collect(child.stdout, logs);
  void collect(child.stderr, logs);
  async function stop(): Promise<void> {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(30_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      if ((await fetch(`${origin}/api/me`)).status === 401) return { origin, dataDir, logs, stop };
    } catch {
      // Still binding its socket.
    }
    await Bun.sleep(200);
  }
  await stop();
  throw new Error(`The hub did not start:\n${logs.join("\n")}`);
}

/** The portal's transport, signed in as one person by their session cookie. */
function cookieTransport(origin: string, cookie: string): Transport {
  return {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await fetch(`${origin}${path}`, {
        method,
        headers: { cookie, origin, ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : undefined;
      if (!res.ok) throw new ApiError(res.status, parsed?.error?.code ?? "unknown", parsed?.error?.message ?? `${method} ${path}: HTTP ${res.status} ${text}`);
      return parsed as T;
    },
    subscribe() {
      throw new Error("The chain test subscribes to nothing.");
    },
  };
}

export type Workspace = { tenantId: string; transport: Transport };

/** The hub's first account, verified as its emailed link would, and the workspace it creates. */
export async function signUp(hub: Hub, database: Database): Promise<Workspace> {
  const email = "owner@example.com";
  const signUp = await fetch(`${hub.origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: hub.origin },
    body: JSON.stringify({ email, password: "password-123456", name: "Owner" }),
  });
  if (!signUp.ok) throw new Error(`Sign-up failed: ${signUp.status} ${await signUp.text()}`);
  const { db, close } = createDB(database.config);
  try {
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.email, email));
  } finally {
    await close();
  }
  const cookie = signUp.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const transport = cookieTransport(hub.origin, cookie);
  const tenant = await transport.fetch<{ id: string }>("POST", "/api/tenants", { name: "Acme", slug: "acme" });
  return { tenantId: tenant.id, transport };
}

async function vaultKey(workspace: Workspace, provider: { name: string; plugin: string; apiBaseUrl: string }, credential: string): Promise<string> {
  const { transport, tenantId } = workspace;
  const created = await transport.fetch<{ id: string }>("POST", `/api/tenants/${tenantId}/providers`, provider);
  const key = await transport.fetch<{ id: string }>("POST", `/api/tenants/${tenantId}/credentials`, { providerId: created.id, name: credential, type: "api_key", secret: `${credential}-key` });
  return key.id;
}

async function offer(workspace: Workspace, provider: { name: string; plugin: string; baseURL: string; credentialId: string }, models: { name: string; quirks?: Record<string, unknown> }[]): Promise<void> {
  const { transport, tenantId } = workspace;
  const catalog = `/api/tenants/${tenantId}/catalog`;
  const row = await transport.fetch<{ id: string }>("POST", `${catalog}/providers`, provider);
  for (const model of models) {
    const created = await transport.fetch<{ id: string }>("POST", `${catalog}/models`, { canonicalName: model.name });
    await transport.fetch("POST", `${catalog}/offerings`, { modelId: created.id, providerId: row.id, priority: 0, ...(model.quirks && { quirks: model.quirks }) });
  }
}

/**
 * Connects the App and its webhook secret, lists its repositories, turns triage on for them and saves both models, each
 * served by `modelOrigin`. The decision model and Anthropic's are written as Settings writes them, at a local endpoint
 * Settings would refuse for not being HTTPS.
 */
export async function setUpWorkspace(workspace: Workspace, github: FakeGithub, modelOrigin: string): Promise<void> {
  const { transport, tenantId } = workspace;
  const provider = await transport.fetch<{ id: string }>("POST", `/api/tenants/${tenantId}/providers`, { name: "github", plugin: "http", apiBaseUrl: github.origin });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  await connectGithubApp(transport, tenantId, { appId: "1", privateKey });
  await transport.fetch("POST", `/api/tenants/${tenantId}/credentials`, { providerId: provider.id, name: "github-hook", type: "api_key", secret: HOOK_SECRET, metadata: xHubHookMetadata("pr-triage", GITHUB_HOOK_HEADERS) });
  await transport.fetch("POST", `/api/integrations/github-installations/${tenantId}/sync`, {});
  await patchAppConfig(transport, tenantId, function enableAll(current) {
    if (!current.repos) throw new Error("Syncing the App's installations recorded no repositories.");
    return { ...current, repos: current.repos.map((row) => ({ ...(row as object), enabled: true })) };
  });
  const decisionKey = await vaultKey(workspace, { name: INFERENCE_PROVIDER, plugin: INFERENCE_PROVIDER, apiBaseUrl: modelOrigin }, INFERENCE_CREDENTIAL_NAME);
  await offer(workspace, { name: INFERENCE_PROVIDER, plugin: INFERENCE_PROVIDER, baseURL: modelOrigin, credentialId: decisionKey }, [{ name: DECISION_MODEL_ALIAS, quirks: { model: "stub" } }]);
}

/** The portal build the hub serves and publishes: its page, and the workflow packages `bun run dev` builds on start. */
export async function buildPortal(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Corbits Triage</title>\n");
  await packWorkflows(join(dir, "packages"));
}

/** Waits for the hub to roll the workspace onto the build's release and its GitHub listener to be up. */
export async function listenerStarted(workspace: Workspace): Promise<void> {
  const deadline = Date.now() + LISTENER_START_MS;
  while (Date.now() < deadline) {
    const versions = await readDeployedVersions(workspace.transport, workspace.tenantId);
    const failed = versions.rollouts.find((rollout) => rollout.error !== undefined);
    if (failed) throw new Error(`The hub could not roll ${failed.source}: ${failed.error}`);
    if (currentDeployment(versions.deployments, TRIAGE_LISTENERS.github)?.live && versions.rollouts.length > 0) return;
    await Bun.sleep(1_000);
  }
  throw new Error("The hub did not start the GitHub listener.");
}

/** A webhook delivery GitHub would send, signed with the App's secret. */
export async function deliver(hub: Hub, workspace: Workspace, event: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const res = await fetch(`${hub.origin}/api/hooks/${workspace.tenantId}/github-hook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", HOOK_SECRET).update(body).digest("hex")}`,
    },
    body,
  });
  if (res.status !== 202) throw new Error(`The hub refused a ${event} delivery: ${res.status} ${await res.text()}`);
}
