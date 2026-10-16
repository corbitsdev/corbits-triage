import { type, type ArkError } from "arktype";
import { LifecycleDuration, lifecycleDurationMs, type ResolvedWorkflowLifecyclePolicy } from "@intx/types";
import { DEFAULT_GITHUB_API_ORIGIN } from "./github/github-app-credential-adapter.js";
import type { CoalesceWindow } from "./github/coalescer.js";
import type { CoordinatorLimits } from "./github/coordinator.js";
import { DEFAULT_RECONCILE_POLICY, type ReconcilePolicy } from "./github/reconcile-plan.js";

const secret = type("string").narrow((value, ctx) =>
  /^[0-9a-fA-F]{64}$/.test(value) || ctx.mustBe("32 bytes encoded as 64 hexadecimal characters"));

const positiveInteger = type("string.integer").narrow((value, ctx) =>
  Number(value) > 0 || ctx.mustBe("a positive integer"));

const lifecycleDuration = type("string.trim").pipe(LifecycleDuration);

const positiveDuration = lifecycleDuration.narrow((value, ctx) =>
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
  "SMTP_URL?": type("string").narrow((value, ctx) =>
    /^smtps?:\/\/[^\s]+$/.test(value) || ctx.mustBe("an smtp:// or smtps:// URL")),
  "EMAIL_FROM?": "string",
  "GITHUB_API_ORIGIN?": "string.url",
  "HUB_SIDECAR_WEBSOCKET_URL?": "string.url",
  "HUB_MAX_TARBALL_BYTES?": positiveInteger,
  "HUB_SIDECAR_STOP_TIMEOUT_MS?": positiveInteger,
  "HUB_SIDECAR_DOCKER_SOCKET?": "string",
  "HUB_SIDECAR_DOCKER_IMAGE?": "string",
  "HUB_SIDECAR_DOCKER_MAX_ALLOCATIONS?": positiveInteger,
  "HUB_SIDECAR_DOCKER_MEMORY_MB?": positiveInteger,
  "HUB_SIDECAR_DOCKER_CPUS?": type("string.numeric").narrow((value, ctx) => Number(value) > 0 || ctx.mustBe("a positive number")),
  "HUB_SIDECAR_E2B_API_KEY?": "string",
  "HUB_SIDECAR_E2B_TEMPLATE?": "string",
  "HUB_SIDECAR_E2B_MAX_ALLOCATIONS?": positiveInteger,
  "TRIAGE_RECONCILE_INTERVAL_MS?": positiveInteger,
  "TRIAGE_BATCH_SIZE?": positiveInteger,
  "TRIAGE_ROTATE_AFTER_RUNS?": positiveInteger,
  "TRIAGE_MAX_IN_FLIGHT?": positiveInteger,
  "TRIAGE_CAPPED_RETRY_MS?": positiveInteger,
  "TRIAGE_COALESCE_QUIET_MS?": positiveInteger,
  "TRIAGE_COORDINATOR?": "'on' | 'off'",
  "TRIAGE_WORKERS_GLOBAL?": positiveInteger,
  "TRIAGE_WORKERS_PER_TENANT?": positiveInteger,
  "TRIAGE_SPAWNS_PER_SECOND?": positiveInteger,
  "HUB_AGENT_GC_PACK_THRESHOLD?": positiveInteger,
  "HUB_AGENT_GC_LOOSE_THRESHOLD?": positiveInteger,
  "HUB_AGENT_GC_WARN_BYTES?": positiveInteger,
  "HUB_PROBE_TIMEOUT_MS?": positiveInteger,
  "HUB_MAIL_HOLD_TTL_MS?": positiveInteger,
  "HUB_MAIL_ACK_RETRY_INTERVAL_MS?": positiveInteger,
  "HUB_MAIL_ACK_MAX_RETRIES?": positiveInteger,
  "WORKFLOW_DEFAULT_MAX_LIFETIME?": positiveDuration,
  "WORKFLOW_DEFAULT_MAX_DISCONNECTED?": positiveDuration,
  "WORKFLOW_DEFAULT_RETENTION_COMPLETED?": lifecycleDuration,
  "WORKFLOW_DEFAULT_RETENTION_FAILED?": lifecycleDuration,
  "WORKFLOW_DEFAULT_RETENTION_CANCELLED?": lifecycleDuration,
  "PATH?": "string",
  "HOME?": "string",
  "TMPDIR?": "string",
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

export type ChildProcessEnv = { PATH?: string; HOME?: string; TMPDIR?: string };

/** The variables child processes (drizzle-kit, sidecars) need to find binaries and scratch space. */
export function childProcessEnv(env: HubEnv): ChildProcessEnv {
  const { PATH, HOME, TMPDIR } = env;
  return { ...(PATH !== undefined && { PATH }), ...(HOME !== undefined && { HOME }), ...(TMPDIR !== undefined && { TMPDIR }) };
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

const COALESCE_BURST_MS = 3_000;

/** Off by default: coalesced mail goes to the host's live listener. On, each window closes into a worker deployment of its own. */
export function triageCoordinator(env: HubEnv): { enabled: boolean; limits: CoordinatorLimits } {
  return {
    enabled: env.TRIAGE_COORDINATOR === "on",
    limits: {
      global: numberOr(env.TRIAGE_WORKERS_GLOBAL, 8),
      perTenant: numberOr(env.TRIAGE_WORKERS_PER_TENANT, 4),
      spawnsPerSecond: numberOr(env.TRIAGE_SPAWNS_PER_SECOND, 2),
    },
  };
}

/**
 * A pull request's webhook events go out as one mail once none arrived for the quiet period, or at most four quiet periods after the first; the window must close before the reconciler gives up on its queued head.
 * A new commit or a newly opened pull request waits only for the burst, long enough to take in the review requests, labels and assignees GitHub delivers with it within a second or so.
 */
export function triageCoalesceWindow(env: HubEnv, policy: ReconcilePolicy): CoalesceWindow {
  const quietMs = numberOr(env.TRIAGE_COALESCE_QUIET_MS, 30_000);
  if (4 * quietMs >= policy.unstartedAfterMs) {
    throw new Error(`TRIAGE_COALESCE_QUIET_MS must be below ${policy.unstartedAfterMs / 4}: four times it must stay under the ${policy.unstartedAfterMs} ms a queued head may wait to start`);
  }
  return { quietMs, maxWaitMs: 4 * quietMs, burstMs: Math.min(COALESCE_BURST_MS, quietMs) };
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
  if (allowedEmails?.length === 0) throw new Error("AUTH_ALLOWED_EMAILS lists no address or @domain");
  if (allowedEmails !== undefined && clientId === undefined) {
    throw new Error("AUTH_ALLOWED_EMAILS requires Google sign-in (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)");
  }
  return {
    ...(clientId !== undefined && clientSecret !== undefined && { google: { clientId, clientSecret } }),
    ...(allowedEmails !== undefined && { allowedEmails }),
  };
}

export type DockerSidecarSettings = {
  socketPath: string;
  image: string;
  size: { memoryBytes?: number; cpus?: number };
  limits: { maxAllocations?: number };
};

/** Unset means no Docker driver: workflows that require workload isolation are refused. */
export function dockerSidecarSettings(env: HubEnv): DockerSidecarSettings | undefined {
  const { HUB_SIDECAR_DOCKER_SOCKET: socketPath, HUB_SIDECAR_DOCKER_IMAGE: image } = env;
  if ((socketPath === undefined) !== (image === undefined)) {
    throw new Error("HUB_SIDECAR_DOCKER_SOCKET and HUB_SIDECAR_DOCKER_IMAGE must be set together");
  }
  if (socketPath === undefined || image === undefined) return undefined;
  // That override writes an adapter entry module into the hub's data dir, which no sidecar image or template has.
  if (githubApiOrigin(env) !== DEFAULT_GITHUB_API_ORIGIN) {
    throw new Error("HUB_SIDECAR_DOCKER_SOCKET cannot be combined with GITHUB_API_ORIGIN");
  }
  const { HUB_SIDECAR_DOCKER_MEMORY_MB: memoryMb, HUB_SIDECAR_DOCKER_CPUS: cpus, HUB_SIDECAR_DOCKER_MAX_ALLOCATIONS: max } = env;
  return {
    socketPath,
    image,
    size: { ...(memoryMb !== undefined && { memoryBytes: Number(memoryMb) * 1024 * 1024 }), ...(cpus !== undefined && { cpus: Number(cpus) }) },
    limits: { ...(max !== undefined && { maxAllocations: Number(max) }) },
  };
}

export type E2bSettings = { apiKey: string; template: string; limits: { maxAllocations?: number } };

/** Unset means no E2B driver. A sandbox dials the hub from the internet, so the sidecar URL must be public wss. */
export function e2bSettings(env: HubEnv): E2bSettings | undefined {
  const { HUB_SIDECAR_E2B_API_KEY: apiKey, HUB_SIDECAR_E2B_TEMPLATE: template } = env;
  if ((apiKey === undefined) !== (template === undefined)) {
    throw new Error("HUB_SIDECAR_E2B_API_KEY and HUB_SIDECAR_E2B_TEMPLATE must be set together");
  }
  if (apiKey === undefined || template === undefined) return undefined;
  if (githubApiOrigin(env) !== DEFAULT_GITHUB_API_ORIGIN) {
    throw new Error("HUB_SIDECAR_E2B_API_KEY cannot be combined with GITHUB_API_ORIGIN");
  }
  if (env.HUB_SIDECAR_WEBSOCKET_URL?.startsWith("wss://") !== true) {
    throw new Error("HUB_SIDECAR_E2B_API_KEY requires a public wss:// HUB_SIDECAR_WEBSOCKET_URL");
  }
  const max = env.HUB_SIDECAR_E2B_MAX_ALLOCATIONS;
  return { apiKey, template, limits: { ...(max !== undefined && { maxAllocations: Number(max) }) } };
}

export type EmailSettings = { smtpUrl: string; from: string };

/** Unset means invites are not emailed; the portal shows the link to copy instead. */
export function emailSettings(env: HubEnv): EmailSettings | undefined {
  const { SMTP_URL: smtpUrl, EMAIL_FROM: from } = env;
  if (smtpUrl === undefined && from !== undefined) throw new Error("EMAIL_FROM requires SMTP_URL");
  if (smtpUrl !== undefined && from === undefined) throw new Error("SMTP_URL requires EMAIL_FROM");
  if (smtpUrl === undefined || from === undefined) return undefined;
  return { smtpUrl, from };
}

/** Where invite links point: the portal's own origin when it is hosted apart from the hub. */
export function inviteLinkOrigin(env: HubEnv): string {
  return new URL(env.PORTAL_ORIGIN ?? env.BETTER_AUTH_BASE_URL).origin;
}

export type InterchangeSettings = {
  port: number;
  dataDir: string;
  principalKeyEncryptionKey: string;
  maxTarballBytes: number;
  agentGc: { packThreshold: number; looseThreshold: number; warnBytes: number };
  probeTimeoutMs?: number;
  sidecarLink: { mailHoldTTLMs: number; mailAckRetryIntervalMs: number; mailAckMaxRetries: number };
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
      mailHoldTTLMs: numberOr(env.HUB_MAIL_HOLD_TTL_MS, 15 * 60_000),
      mailAckRetryIntervalMs: numberOr(env.HUB_MAIL_ACK_RETRY_INTERVAL_MS, 30_000),
      mailAckMaxRetries: numberOr(env.HUB_MAIL_ACK_MAX_RETRIES, 10),
    },
    sidecarWebSocketUrl: env.HUB_SIDECAR_WEBSOCKET_URL ?? `ws://127.0.0.1:${port}/api/sidecars/ws`,
    defaultLifecyclePolicy: {
      maxLifetime: env.WORKFLOW_DEFAULT_MAX_LIFETIME ?? "7d",
      maxDisconnected: env.WORKFLOW_DEFAULT_MAX_DISCONNECTED ?? "15m",
      capacityRetention: {
        completed: env.WORKFLOW_DEFAULT_RETENTION_COMPLETED ?? "30m",
        failed: env.WORKFLOW_DEFAULT_RETENTION_FAILED ?? "24h",
        cancelled: env.WORKFLOW_DEFAULT_RETENTION_CANCELLED ?? "1h",
      },
    },
  };
}
