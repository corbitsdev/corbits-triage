// The live chain on one machine: a migrated database of its own, the hub process with its local sidecars serving a
// portal build, and a workspace set up through the same routes and portal code a person's browser uses.
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDB, schema } from "@intx/db";
import { ApiError, type Transport } from "@intx/hub-client";
import { GITHUB_HOOK_HEADERS, xHubHookMetadata } from "@corbits/common/hook-metadata";
import { packWorkflows } from "../../apps/web/scripts/build-workflows.ts";
import { DECISION_MODEL_ALIAS, DEFAULT_TIMINGS, INFERENCE_PROVIDER, TIMING_VARIABLES, TRIAGE_LISTENERS, type Timings } from "@corbits/triage-contracts";
import { currentDeployment, INFERENCE_CREDENTIAL_NAME, patchAppConfig, readDeployedVersions } from "../../apps/web/src/lib/hub-api.ts";
import { connectGithubApp } from "../../apps/web/src/lib/github-manifest.ts";
import type { FakeGithub } from "./github.ts";

const ROOT = resolve(import.meta.dir, "../..");
/** The logs of every chain file, kept after the run for CI to upload; `tmp/` is gitignored. */
const LOG_ROOT = join(ROOT, "tmp", "chain-logs");
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
/** How long a stopped hub may take to exit before it is killed. */
const STOP_MS = 30_000;
/** How often the harness reads the state it waits on. */
export const POLL_MS = 100;

/**
 * The waits the hub runs on in the chain, short so a scenario waits on the state it names rather than on production
 * windows.
 */
export const TIMINGS: Timings = {
  ...DEFAULT_TIMINGS,
  reconcileIntervalMs: 15_000,
  reconcileRetryMs: 1_000,
  coalesceQuietMs: 500,
};

/**
 * Stock's hold on mail to a just-deployed run, and so the hub's start grace for a manager. A manager must still reach
 * its sidecar inside it, which takes half a minute on a loaded machine.
 */
export const MAIL_HOLD_MS = 60_000;

function timingEnv(timings: Timings): Record<string, string> {
  return Object.fromEntries(Object.entries(TIMING_VARIABLES).map(([key, variable]) => [variable, String(timings[key as keyof Timings])]));
}

export type Database = { name: string; url: string; config: typeof ADMIN_DB };

export async function createDatabase(): Promise<Database> {
  const name = `corbits_chain_${randomBytes(6).toString("hex")}`;
  const admin = createDB(ADMIN_DB);
  try {
    await admin.db.execute(sql.raw(`create database ${name}`));
  } finally {
    await cleanup("close the admin connection", () => admin.close());
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
    await cleanup("close the admin connection", () => admin.close());
  }
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null) });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function collect(stream: ReadableStream<Uint8Array>, lines: string[], file: string): Promise<void> {
  const decoder = new TextDecoder();
  let partial = "";
  for await (const chunk of stream) {
    const parts = (partial + decoder.decode(chunk, { stream: true })).split("\n");
    partial = parts.pop()!;
    lines.push(...parts);
    if (parts.length > 0) appendFileSync(file, `${parts.join("\n")}\n`);
  }
}

export type Hub = { origin: string; dataDir: string; logs: string[]; logFile: string; stop: () => Promise<void> };

/** The hub as the image starts it, serving the portal build in `portalDir`, with its sidecar a local process under its data directory. */
export async function startHub(database: Database, github: FakeGithub, portalDir: string, env: Record<string, string> = {}): Promise<Hub> {
  const port = freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "corbits-chain-"));
  const logs: string[] = [];
  const logDir = join(LOG_ROOT, basename(Bun.main, ".test.ts"));
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `hub-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.log`);
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
      ...timingEnv(TIMINGS),
      HUB_MAIL_HOLD_TTL_MS: String(MAIL_HOLD_MS),
      // Every sidecar a local process, as on a hub without Docker, so each reaches the fake GitHub and model on loopback.
      DOCKER_HOST: "unix:///nonexistent/docker.sock",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  void collect(child.stdout, logs, logFile);
  void collect(child.stderr, logs, logFile);
  async function stop(): Promise<void> {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(STOP_MS)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
  const deadline = Date.now() + READY_MS;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      if ((await fetch(`${origin}/api/me`)).status === 401) return { origin, dataDir, logs, logFile, stop };
    } catch {
      // Still binding its socket.
    }
    await Bun.sleep(POLL_MS);
  }
  await stop();
  throw new Error(`The hub did not start.\n${hubLogTail({ logs, logFile })}`);
}

/**
 * Where the logs are and the hub's last lines, for a failure message. The hub's log holds its sidecars' and their
 * workflow processes' output too, which they inherit.
 */
export function hubLogTail({ logs, logFile }: Pick<Hub, "logs" | "logFile">): string {
  return `Logs: ${dirname(logFile)}\nHub log: ${logFile}\n${logs.slice(-80).join("\n")}`;
}

const cleanupFailures: string[] = [];

/**
 * Runs a cleanup step from a `finally` or `afterAll`. Its failure is logged and kept rather than thrown, so it cannot
 * replace the error the scenario is already throwing; `failOnCleanupErrors` raises what was kept.
 */
export async function cleanup(what: string, step: () => unknown): Promise<void> {
  try {
    await step();
  } catch (err) {
    console.error(`Could not ${what}: ${String(err)}`);
    cleanupFailures.push(`Could not ${what}: ${String(err)}`);
  }
}

/** The last line of a file's `afterAll`, so a cleanup that failed fails the file even when every scenario passed. */
export function failOnCleanupErrors(): void {
  const failed = cleanupFailures.splice(0);
  if (failed.length > 0) throw new Error(failed.join("\n"));
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
    await cleanup("close the database connection", close);
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
    await Bun.sleep(POLL_MS);
  }
  throw new Error("The hub did not start the GitHub listener.");
}

/** A webhook delivery GitHub would send, signed with the App's secret; the hub's answer names what it did with it. */
export async function deliver(hub: Hub, workspace: Workspace, event: string, payload: unknown): Promise<string> {
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
  return ((await res.json()) as { status: string }).status;
}
