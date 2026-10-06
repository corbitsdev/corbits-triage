import { type, type ArkError } from "arktype";
import { DEFAULT_GITHUB_API_ORIGIN } from "./github/github-app-credential-adapter.js";

const secret = type("string").narrow((value, ctx) =>
  /^[0-9a-fA-F]{64}$/.test(value) || ctx.mustBe("32 bytes encoded as 64 hexadecimal characters"));

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
  "GITHUB_API_ORIGIN?": "string.url",
  "HUB_SIDECAR_WEBSOCKET_URL?": "string.url",
  "HUB_MAX_TARBALL_BYTES?": "string.integer",
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
