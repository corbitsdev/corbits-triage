import { createPrivateKey, X509Certificate } from "node:crypto";
import { homedir } from "node:os";
import { type, type ArkError } from "arktype";
import type { DockerTls, FindDockerHostOpts } from "@corbits/provisioner-docker";
import { LifecycleDuration, lifecycleDurationMs, type ResolvedWorkflowLifecyclePolicy } from "@intx/types";
import { DEFAULT_GITHUB_API_ORIGIN } from "./github/github-app-credential-adapter.js";
import type { CoalesceWindow } from "./github/coalescer.js";
import { DEFAULT_RECONCILE_POLICY, type ReconcilePolicy } from "./github/reconcile-plan.js";

const secret = type("string").narrow((value, ctx) =>
  /^[0-9a-fA-F]{64}$/.test(value) || ctx.mustBe("32 bytes encoded as 64 hexadecimal characters"));

const positiveInteger = type("string.integer").narrow((value, ctx) =>
  Number(value) > 0 || ctx.mustBe("a positive integer"));

const lifecycleDuration = type("string.trim").pipe(LifecycleDuration);

const positiveDuration = lifecycleDuration.narrow((value, ctx) =>
  lifecycleDurationMs(value) > 0 || ctx.mustBe("greater than zero"));

/** A PEM file encoded as one line of base64, which every .env format and variable UI keeps intact. */
function base64Pem(parse: (pem: string) => unknown, expected: string) {
  return type("string").pipe(function decodePem(value, ctx) {
    const pem = Buffer.from(value, "base64").toString("utf8");
    try {
      parse(pem);
      return pem;
    } catch {
      return ctx.error(expected);
    }
  });
}
const base64Certificate = base64Pem((pem) => new X509Certificate(pem), "a PEM certificate encoded as base64");
const base64PrivateKey = base64Pem(createPrivateKey, "a PEM private key encoded as base64");

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
  "BITBUCKET_EGRESS_ALLOWLIST?": "string",
  "HUB_SIDECAR_WEBSOCKET_URL?": "string.url",
  "HUB_API_ORIGIN?": "string.url",
  "HUB_MAX_TARBALL_BYTES?": positiveInteger,
  "HUB_SIDECAR_STOP_TIMEOUT_MS?": positiveInteger,
  "DOCKER_HOST?": "string",
  "DOCKER_CONTEXT?": "string",
  "DOCKER_TLS_CA?": base64Certificate,
  "DOCKER_TLS_CERT?": base64Certificate,
  "DOCKER_TLS_KEY?": base64PrivateKey,
  "E2B_API_KEY?": "string",
  "RAILWAY_SANDBOX_TOKEN?": "string",
  "RAILWAY_SANDBOX_ENVIRONMENT_ID?": "string",
  "RAILWAY_GIT_COMMIT_SHA?": "string",
  "RAILWAY_GIT_REPO_OWNER?": "string",
  "RAILWAY_GIT_REPO_NAME?": "string",
  "RAILWAY_ENVIRONMENT_ID?": "string",
  "TRIAGE_RECONCILE_INTERVAL_MS?": positiveInteger,
  "TRIAGE_MAX_IN_FLIGHT?": positiveInteger,
  "TRIAGE_CAPPED_RETRY_MS?": positiveInteger,
  "TRIAGE_COALESCE_QUIET_MS?": positiveInteger,
  "HUB_AGENT_GC_PACK_THRESHOLD?": positiveInteger,
  "HUB_AGENT_GC_LOOSE_THRESHOLD?": positiveInteger,
  "HUB_AGENT_GC_WARN_BYTES?": positiveInteger,
  "HUB_PROBE_TIMEOUT_MS?": positiveInteger,
  "HUB_MAIL_HOLD_TTL_MS?": positiveInteger,
  "HUB_MAIL_ACK_RETRY_INTERVAL_MS?": positiveInteger,
  "HUB_MAIL_ACK_MAX_RETRIES?": positiveInteger,
  "WORKFLOW_DEFAULT_MAX_LIFETIME?": positiveDuration,
  "WORKFLOW_DEFAULT_MAX_DISCONNECTED?": positiveDuration,
  "PATH?": "string",
  "HOME?": "string",
  "TMPDIR?": "string",
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

function presentValues(raw: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined && value.trim() !== ""));
}

/** Blank values count as missing. Errors never echo values. */
export function loadHubEnv(raw: Record<string, string | undefined>): HubEnv {
  const env = HubEnvSchema(presentValues(raw));
  if (env instanceof type.errors) throw new Error(env.map(describeEnvError).join("\n"));
  return env;
}

const DatabaseEnvSchema = HubEnvSchema.pick("DATABASE_URL", "DB_STATEMENT_TIMEOUT_MS", "PATH", "HOME", "TMPDIR");

/** The hub variables `db:migrate` needs, read the same way. */
export function loadDatabaseEnv(raw: Record<string, string | undefined>): typeof DatabaseEnvSchema.infer {
  const env = DatabaseEnvSchema(presentValues(raw));
  if (env instanceof type.errors) throw new Error(env.map(describeEnvError).join("\n"));
  return env;
}

/** Hostnames or literal IPs that may be private or loopback. Empty or unset means no exceptions. */
export function bitbucketEgressAllowlist(env: HubEnv): readonly string[] {
  const raw = env.BITBUCKET_EGRESS_ALLOWLIST;
  if (raw === undefined) return [];
  return raw.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

/** Unset means production GitHub; a set origin (e.g. a local emulator) loses any trailing slash. */
export function githubApiOrigin(env: HubEnv): string {
  return env.GITHUB_API_ORIGIN === undefined ? DEFAULT_GITHUB_API_ORIGIN : env.GITHUB_API_ORIGIN.trim().replace(/\/+$/, "");
}

/** The sidecar websocket at a hub base URL: `wss://` for `https://`, else `ws://`. */
function websocketUrlOf(baseUrl: string): string {
  const url = new URL("/api/sidecars/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** Where sidecars on another machine reach the hub. */
function publicHubWebSocketUrl(env: HubEnv): string {
  return env.HUB_SIDECAR_WEBSOCKET_URL ?? websocketUrlOf(env.BETTER_AUTH_BASE_URL);
}

export type DockerSettings = FindDockerHostOpts & {
  readonly tls?: DockerTls;
  /** Where sidecars on another machine reach the hub. */
  readonly publicHubWebSocketUrl: string;
};

/**
 * Where to look for the Docker daemon and how to reach it, as the docker CLI does: `DOCKER_HOST`, `DOCKER_CONTEXT`, then
 * its config and sockets under `home`; TLS with the PEMs in `DOCKER_TLS_CA`, `DOCKER_TLS_CERT` and `DOCKER_TLS_KEY`.
 */
export function dockerSettings(env: HubEnv): DockerSettings {
  const home = env.HOME ?? homedir();
  const { DOCKER_TLS_CA: ca, DOCKER_TLS_CERT: cert, DOCKER_TLS_KEY: key } = env;
  const tlsSet = [ca, cert, key].filter((value) => value !== undefined).length;
  if (tlsSet !== 0 && tlsSet !== 3) throw new Error("DOCKER_TLS_CA, DOCKER_TLS_CERT and DOCKER_TLS_KEY must be set together");
  return {
    ...(env.DOCKER_HOST !== undefined && { dockerHost: env.DOCKER_HOST }),
    ...(env.DOCKER_CONTEXT !== undefined && { dockerContext: env.DOCKER_CONTEXT }),
    ...(ca !== undefined && cert !== undefined && key !== undefined && { tls: { ca, cert, key } }),
    home,
    publicHubWebSocketUrl: publicHubWebSocketUrl(env),
  };
}

export type E2bSettings = {
  readonly apiKey: string;
  /** Where sandboxes reach the hub. */
  readonly publicHubWebSocketUrl: string;
};

/** Unset `E2B_API_KEY` means no E2B provisioner. */
export function e2bSettings(env: HubEnv): E2bSettings | undefined {
  if (env.E2B_API_KEY === undefined) return undefined;
  return { apiKey: env.E2B_API_KEY, publicHubWebSocketUrl: publicHubWebSocketUrl(env) };
}

export type RailwaySandboxSettings = {
  readonly token: string;
  readonly environmentId: string;
  /** The public GitHub repository and commit the hub was deployed from, which the sidecar template checks out. */
  readonly repository: string;
  readonly commit: string;
  readonly publicHubWebSocketUrl: string;
};

/**
 * Unset token and environment mean no Railway sandboxes. Railway sets the `RAILWAY_GIT_*` variables on a service it
 * deploys from GitHub; a hub deployed any other way sets them itself.
 */
export function railwaySandboxSettings(env: HubEnv): RailwaySandboxSettings | undefined {
  const { RAILWAY_SANDBOX_TOKEN: token, RAILWAY_SANDBOX_ENVIRONMENT_ID: environmentId } = env;
  if (token === undefined && environmentId === undefined) return undefined;
  if (token === undefined || environmentId === undefined) {
    throw new Error("RAILWAY_SANDBOX_TOKEN and RAILWAY_SANDBOX_ENVIRONMENT_ID must be set together");
  }
  const { RAILWAY_GIT_COMMIT_SHA: commit, RAILWAY_GIT_REPO_OWNER: owner, RAILWAY_GIT_REPO_NAME: name } = env;
  if (commit === undefined || owner === undefined || name === undefined) {
    throw new Error("RAILWAY_SANDBOX_TOKEN requires RAILWAY_GIT_COMMIT_SHA, RAILWAY_GIT_REPO_OWNER and RAILWAY_GIT_REPO_NAME");
  }
  // They go into the template's shell commands.
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("RAILWAY_GIT_COMMIT_SHA must be a full commit hash");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) throw new Error("RAILWAY_GIT_REPO_OWNER and RAILWAY_GIT_REPO_NAME must be a GitHub owner and repository name");
  return { token, environmentId, repository: `https://github.com/${owner}/${name}`, commit, publicHubWebSocketUrl: publicHubWebSocketUrl(env) };
}

export type ChildProcessEnv = { PATH?: string; HOME?: string; TMPDIR?: string };

/** The variables child processes (drizzle-kit, sidecars) need to find binaries and scratch space. */
export function childProcessEnv(env: Pick<HubEnv, "PATH" | "HOME" | "TMPDIR">): ChildProcessEnv {
  const { PATH, HOME, TMPDIR } = env;
  return { ...(PATH !== undefined && { PATH }), ...(HOME !== undefined && { HOME }), ...(TMPDIR !== undefined && { TMPDIR }) };
}

/** `sslmode=require` (or stricter) turns on TLS. */
export function databaseConfig(env: Pick<HubEnv, "DATABASE_URL" | "DB_STATEMENT_TIMEOUT_MS">): DatabaseConfig {
  const url = new URL(env.DATABASE_URL);
  const sslMode = url.searchParams.get("sslmode") ?? "";
  return {
    host: decodeURIComponent(url.hostname),
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ...(["require", "verify-ca", "verify-full"].includes(sslMode) && { ssl: true }),
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

/** Heads the reconciler lets a tenant have queued or running at once; each runs in a worker sidecar of its own. */
export function triageReconcilePolicy(env: Pick<HubEnv, "TRIAGE_MAX_IN_FLIGHT" | "TRIAGE_CAPPED_RETRY_MS">): ReconcilePolicy {
  return {
    ...DEFAULT_RECONCILE_POLICY,
    maxInFlight: numberOr(env.TRIAGE_MAX_IN_FLIGHT, DEFAULT_RECONCILE_POLICY.maxInFlight),
    cappedRetryAfterMs: numberOr(env.TRIAGE_CAPPED_RETRY_MS, DEFAULT_RECONCILE_POLICY.cappedRetryAfterMs),
  };
}

const COALESCE_BURST_MS = 3_000;

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
 * An allowlist admits only verified addresses: without email the hub cannot
 * verify one, so only a provider that verifies email (Google) can satisfy it.
 */
export function signInSettings(env: HubEnv): SignInSettings {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, AUTH_ALLOWED_EMAILS: allowed } = env;
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together");
  }
  const allowedEmails = allowed?.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (allowedEmails?.length === 0) throw new Error("AUTH_ALLOWED_EMAILS lists no address or @domain");
  if (allowedEmails !== undefined && clientId === undefined && env.SMTP_URL === undefined) {
    throw new Error("AUTH_ALLOWED_EMAILS requires Google sign-in (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET) or email (SMTP_URL)");
  }
  return {
    ...(clientId !== undefined && clientSecret !== undefined && { google: { clientId, clientSecret } }),
    ...(allowedEmails !== undefined && { allowedEmails }),
  };
}

/**
 * The header a hosting platform's own proxy sets to the caller's address, picked by a variable the platform sets on
 * the service: Railway's edge sets `X-Real-IP`. Undefined on any other host.
 */
export function clientIpHeaders(env: Pick<HubEnv, "RAILWAY_ENVIRONMENT_ID">): string[] | undefined {
  if (env.RAILWAY_ENVIRONMENT_ID !== undefined) return ["x-real-ip"];
  return undefined;
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
  hubApiOrigin?: string;
  sidecarLink: { mailHoldTTLMs: number; mailAckRetryIntervalMs: number; mailAckMaxRetries: number };
  sidecarWebSocketUrl: string;
  defaultLifecyclePolicy: ResolvedWorkflowLifecyclePolicy;
};

function numberOr(value: string | undefined, stock: number): number {
  return value === undefined ? stock : Number(value);
}

/** Unset values keep Interchange's stock defaults, except the sidecar link settings and capacity retention. */
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
    ...(env.HUB_API_ORIGIN !== undefined && { hubApiOrigin: env.HUB_API_ORIGIN }),
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
      // Run history lives on the hub, so an ended run's sidecar has nothing left to keep.
      capacityRetention: { completed: "0s", failed: "0s", cancelled: "0s" },
    },
  };
}
