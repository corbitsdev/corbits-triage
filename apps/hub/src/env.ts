import { type, type ArkError } from "arktype";
import { LifecycleDuration, lifecycleDurationMs, type ResolvedWorkflowLifecyclePolicy } from "@intx/types";
import { DEFAULT_GITHUB_API_ORIGIN } from "./github/github-app-credential-adapter.js";
import { DEFAULT_RECONCILE_POLICY, type ReconcilePolicy } from "./github/reconcile-plan.js";

const secret = type("string").narrow((value, ctx) =>
  /^[0-9a-fA-F]{64}$/.test(value) || ctx.mustBe("32 bytes encoded as 64 hexadecimal characters"));

const positiveInteger = type("string.integer").narrow((value, ctx) =>
  Number(value) > 0 || ctx.mustBe("a positive integer"));

const lifecycleDuration = type("string.trim").pipe(LifecycleDuration);

const maxLifetime = lifecycleDuration.narrow((value, ctx) =>
  lifecycleDurationMs(value) > 0 || ctx.mustBe("greater than zero"));

const HubEnvSchema = type({
  DATABASE_URL: type("string").narrow((value, ctx) =>
    /^postgres(ql)?:\/\//.test(value) || ctx.mustBe("a postgres:// or postgresql:// URL")),
  BETTER_AUTH_SECRET: secret,
  CREDENTIAL_ENCRYPTION_KEY: secret,
  PRINCIPAL_KEY_ENCRYPTION_KEY: secret,
  SIDECAR_CREDENTIAL_ENCRYPTION_KEY: secret,
  BETTER_AUTH_BASE_URL: "string.url",
  PORT: "string.integer",
  HUB_DATA_DIR: "string",
  "PORTAL_DIR?": "string",
  "PORTAL_ORIGIN?": "string.url",
  "GOOGLE_CLIENT_ID?": "string",
  "GOOGLE_CLIENT_SECRET?": "string",
  "AUTH_ALLOWED_EMAILS?": "string",
  "GITHUB_API_ORIGIN?": "string.url",
  "HUB_SIDECAR_WEBSOCKET_URL?": "string.url",
  "HUB_MAX_TARBALL_BYTES?": positiveInteger,
  "HUB_SIDECAR_STOP_TIMEOUT_MS?": positiveInteger,
  "TRIAGE_RECONCILE_INTERVAL_MS?": positiveInteger,
  "TRIAGE_BATCH_SIZE?": positiveInteger,
  "TRIAGE_ROTATE_AFTER_RUNS?": positiveInteger,
  "TRIAGE_MAX_IN_FLIGHT?": positiveInteger,
  "TRIAGE_CAPPED_RETRY_MS?": positiveInteger,
  "HUB_AGENT_GC_PACK_THRESHOLD?": positiveInteger,
  "HUB_AGENT_GC_LOOSE_THRESHOLD?": positiveInteger,
  "HUB_AGENT_GC_WARN_BYTES?": positiveInteger,
  "HUB_PROBE_TIMEOUT_MS?": positiveInteger,
  "HUB_DISCONNECT_QUEUE_TTL_MS?": positiveInteger,
  "HUB_MAIL_ACK_RETRY_INTERVAL_MS?": positiveInteger,
  "HUB_MAIL_ACK_MAX_RETRIES?": positiveInteger,
  "WORKFLOW_DEFAULT_MAX_LIFETIME?": maxLifetime,
  "WORKFLOW_DEFAULT_RETENTION_COMPLETED?": lifecycleDuration,
  "WORKFLOW_DEFAULT_RETENTION_FAILED?": lifecycleDuration,
  "WORKFLOW_DEFAULT_RETENTION_CANCELLED?": lifecycleDuration,
  "PG_SCHEMA?": "string",
  "DB_STATEMENT_TIMEOUT_MS?": "string.integer",
});

export type HubEnv = typeof HubEnvSchema.infer;

export type DatabaseConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
  schema?: string;
  statementTimeoutMs?: number;
};

function describeEnvError(error: ArkError): string {
  const name = error.path.join(".");
  return error.code === "required" ? `${name} environment variable is required` : `${name} must be ${error.expected}`;
}

/** Blank values count as missing. Errors never echo values. */
export function loadHubEnv(raw: Record<string, string | undefined>): HubEnv {
  const present = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined && value.trim() !== ""));
  const env = HubEnvSchema(present);
  if (env instanceof type.errors) throw new Error(env.map(describeEnvError).join("\n"));
  return env;
}

/** Unset means production GitHub; a set origin (e.g. a local emulator) loses any trailing slash. */
export function githubApiOrigin(env: HubEnv): string {
  return env.GITHUB_API_ORIGIN === undefined ? DEFAULT_GITHUB_API_ORIGIN : env.GITHUB_API_ORIGIN.trim().replace(/\/+$/, "");
}

/** `sslmode=require` (or stricter) turns on TLS. */
export function databaseConfig(env: HubEnv): DatabaseConfig {
  const url = new URL(env.DATABASE_URL);
  const sslMode = url.searchParams.get("sslmode") ?? "";
  return {
    host: decodeURIComponent(url.hostname),
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ...(["require", "verify-ca", "verify-full"].includes(sslMode) && { ssl: true }),
    ...(env.PG_SCHEMA !== undefined && { schema: env.PG_SCHEMA }),
    ...(env.DB_STATEMENT_TIMEOUT_MS !== undefined && { statementTimeoutMs: Number(env.DB_STATEMENT_TIMEOUT_MS) }),
  };
}

/** The `DB_*` variables the vendored drizzle migration config reads. */
export function migrationEnv(db: DatabaseConfig): Record<string, string> {
  return {
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_USER: db.user,
    DB_PASSWORD: db.password,
    DB_NAME: db.database,
    DB_SSL: String(db.ssl === true),
  };
}

/** How often the hub re-queues open pull requests whose head is not triaged. */
export function triageReconcileIntervalMs(env: HubEnv): number {
  return env.TRIAGE_RECONCILE_INTERVAL_MS === undefined ? 5 * 60_000 : Number(env.TRIAGE_RECONCILE_INTERVAL_MS);
}

/** Heads one catch-up mail carries at most; each run's steps share one timeout, so this bounds per-step load. */
export function triageBatchSize(env: HubEnv): number {
  return env.TRIAGE_BATCH_SIZE === undefined ? 5 : Number(env.TRIAGE_BATCH_SIZE);
}

/**
 * The stock hub checks every commit pushed to a deployment's run log against
 * the whole log, so the hub replaces the pr-triage deployment with a fresh copy
 * once its log holds more runs than this.
 */
export function triageRotateAfterRuns(env: HubEnv): number {
  return numberOr(env.TRIAGE_ROTATE_AFTER_RUNS, 15);
}

/** Heads a tenant may have queued or running at once; each in-flight run adds commits to the pack a rotation receives. */
export function triageReconcilePolicy(env: Pick<HubEnv, "TRIAGE_MAX_IN_FLIGHT" | "TRIAGE_CAPPED_RETRY_MS">): ReconcilePolicy {
  return {
    ...DEFAULT_RECONCILE_POLICY,
    maxInFlight: numberOr(env.TRIAGE_MAX_IN_FLIGHT, DEFAULT_RECONCILE_POLICY.maxInFlight),
    cappedRetryAfterMs: numberOr(env.TRIAGE_CAPPED_RETRY_MS, DEFAULT_RECONCILE_POLICY.cappedRetryAfterMs),
  };
}

export type SignInSettings = {
  google?: { clientId: string; clientSecret: string };
  allowedEmails?: string[];
};

/**
 * An allowlist turns email/password off: those addresses are never verified,
 * so only a provider that verifies email (Google) can satisfy it.
 */
export function signInSettings(env: HubEnv): SignInSettings {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, AUTH_ALLOWED_EMAILS: allowed } = env;
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together");
  }
  const allowedEmails = allowed?.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (allowedEmails !== undefined && clientId === undefined) {
    throw new Error("AUTH_ALLOWED_EMAILS requires Google sign-in (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)");
  }
  return {
    ...(clientId !== undefined && clientSecret !== undefined && { google: { clientId, clientSecret } }),
    ...(allowedEmails !== undefined && { allowedEmails }),
  };
}

export type InterchangeSettings = {
  port: number;
  dataDir: string;
  principalKeyEncryptionKey: string;
  maxTarballBytes: number;
  agentGc: { packThreshold: number; looseThreshold: number; warnBytes: number };
  probeTimeoutMs?: number;
  sidecarLink: { disconnectQueueTTLMs: number; mailAckRetryIntervalMs: number; mailAckMaxRetries: number };
  sidecarWebSocketUrl: string;
  defaultLifecyclePolicy: ResolvedWorkflowLifecyclePolicy;
};

function numberOr(value: string | undefined, stock: number): number {
  return value === undefined ? stock : Number(value);
}

/** Unset values keep Interchange's stock defaults. */
export function interchangeSettings(env: HubEnv): InterchangeSettings {
  const port = Number(env.PORT);
  return {
    port,
    dataDir: env.HUB_DATA_DIR,
    principalKeyEncryptionKey: env.PRINCIPAL_KEY_ENCRYPTION_KEY,
    // Tool packages are the curated subset the operator vets, so an upload past
    // 10 MiB is far more likely misuse than a legitimate build.
    maxTarballBytes: numberOr(env.HUB_MAX_TARBALL_BYTES, 10 * 1024 * 1024),
    agentGc: {
      packThreshold: numberOr(env.HUB_AGENT_GC_PACK_THRESHOLD, 64),
      looseThreshold: numberOr(env.HUB_AGENT_GC_LOOSE_THRESHOLD, 2048),
      warnBytes: numberOr(env.HUB_AGENT_GC_WARN_BYTES, 256 * 1024 * 1024),
    },
    ...(env.HUB_PROBE_TIMEOUT_MS !== undefined && { probeTimeoutMs: Number(env.HUB_PROBE_TIMEOUT_MS) }),
    // Triage mail is routed, not dispatched, so only the router's ack retries keep it alive. A
    // pack receive holds the connection queue for minutes and the stock 5 x 10 s give-up drops it.
    sidecarLink: {
      disconnectQueueTTLMs: numberOr(env.HUB_DISCONNECT_QUEUE_TTL_MS, 15 * 60_000),
      mailAckRetryIntervalMs: numberOr(env.HUB_MAIL_ACK_RETRY_INTERVAL_MS, 30_000),
      mailAckMaxRetries: numberOr(env.HUB_MAIL_ACK_MAX_RETRIES, 10),
    },
    sidecarWebSocketUrl: env.HUB_SIDECAR_WEBSOCKET_URL ?? `ws://127.0.0.1:${port}/api/sidecars/ws`,
    defaultLifecyclePolicy: {
      maxLifetime: env.WORKFLOW_DEFAULT_MAX_LIFETIME ?? "7d",
      capacityRetention: {
        completed: env.WORKFLOW_DEFAULT_RETENTION_COMPLETED ?? "30m",
        failed: env.WORKFLOW_DEFAULT_RETENTION_FAILED ?? "24h",
        cancelled: env.WORKFLOW_DEFAULT_RETENTION_CANCELLED ?? "1h",
      },
    },
  };
}
