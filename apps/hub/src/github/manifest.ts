import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { type } from "arktype";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { generateId } from "@intx/hub-common";

const { credential, principal, provider } = schema;

type SessionResult = {
  user: { id: string };
  session: { id: string };
};
type GetSession = (headers: Headers) => Promise<SessionResult | null>;
type AuthorizeCredential = (principalId: string, tenantId: string, resource: string, action: "create" | "manage") => Promise<boolean>;

export const GITHUB_MANIFEST_PATH = "/api/integrations/github-manifest";
export const GITHUB_MANIFEST_CALLBACK_PATH = `${GITHUB_MANIFEST_PATH}/callback`;
export const GITHUB_MANIFEST_MAX_AGE_MS = 60 * 60_000;

export const GITHUB_APP_PERMISSIONS = {
  checks: "read",
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
} as const;

export const GITHUB_APP_EVENTS = [
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "check_run",
  "installation",
  "installation_repositories",
] as const;

export type GithubAppManifest = {
  name: string;
  url: string;
  hook_attributes: { url: string; active: true };
  redirect_url: string;
  public: false;
  default_permissions: typeof GITHUB_APP_PERMISSIONS;
  default_events: typeof GITHUB_APP_EVENTS;
  request_oauth_on_install: false;
};

export function buildGithubAppManifest(portalOrigin: string, hookUrl: string, callbackUrl: string): GithubAppManifest {
  return {
    name: "Corbits Triage",
    url: portalOrigin,
    hook_attributes: { url: hookUrl, active: true },
    redirect_url: callbackUrl,
    public: false,
    default_permissions: GITHUB_APP_PERMISSIONS,
    default_events: GITHUB_APP_EVENTS,
    request_oauth_on_install: false,
  };
}

export function manifestSecurityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action https://github.com; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

const ManifestConversion = type({
  id: "number.integer >= 1",
  slug: "string > 0",
  pem: "string > 0",
  webhook_secret: "string > 0",
});
export type ManifestConversion = typeof ManifestConversion.infer;

export type ManifestIdentity = {
  sessionId: string;
  principalId: string;
  tenantId: string;
};

export type ClaimedManifest = ManifestIdentity & {
  stateHash: string;
  appCredentialId: string;
  hookCredentialId: string;
  returnOrigin: string;
  replacement?: boolean;
};

type RejectionReason = "not_found" | "identity_mismatch" | "expired" | "completed" | "processing" | "failed";
type ClaimResult = { kind: "claimed"; value: ClaimedManifest } | { kind: "rejected"; reason: RejectionReason };

export type ManifestCompletionStore = {
  claim(stateHash: string, identity: ManifestIdentity): Promise<ClaimResult>;
  commit(claimed: ClaimedManifest, conversion: ManifestConversion): Promise<void>;
  release(claimed: ClaimedManifest, retryable: boolean): Promise<void>;
};

type CompletionResult =
  | { kind: "completed"; appSlug: string; returnOrigin: string }
  | { kind: "rejected"; reason: RejectionReason }
  | { kind: "failed"; retryable: boolean };

class GithubExchangeError extends Error {
  constructor(readonly retryable: boolean) {
    super("GitHub manifest conversion failed");
  }
}

export async function exchangeGithubManifest(code: string, githubApiOrigin: string, fetchImpl: typeof fetch): Promise<ManifestConversion> {
  const response = await fetchImpl(`${githubApiOrigin}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new GithubExchangeError(response.status >= 500);
  return ManifestConversion.assert(await response.json());
}

export async function completeManifest({ state, code, identity, store, exchange, log }: {
  state: string;
  code: string;
  identity: ManifestIdentity;
  store: ManifestCompletionStore;
  exchange: (code: string) => Promise<ManifestConversion>;
  log?: (event: { event: string; retryable?: boolean }) => void;
}): Promise<CompletionResult> {
  const claimed = await store.claim(hashState(state), identity);
  if (claimed.kind === "rejected") return claimed;
  try {
    const conversion = await exchange(code);
    try {
      await store.commit(claimed.value, conversion);
    } catch {
      await store.release(claimed.value, false);
      log?.({ event: "github_manifest_commit_failed", retryable: false });
      return { kind: "failed", retryable: false };
    }
    log?.({ event: "github_manifest_completed" });
    return { kind: "completed", appSlug: conversion.slug, returnOrigin: claimed.value.returnOrigin };
  } catch (cause) {
    const retryable = cause instanceof GithubExchangeError ? cause.retryable : true;
    await store.release(claimed.value, retryable);
    log?.({ event: "github_manifest_exchange_failed", retryable });
    return { kind: "failed", retryable };
  }
}

export const githubManifestState = pgTable("corbits_github_manifest_state", {
  stateHash: text("state_hash").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  principalId: text("principal_id").notNull(),
  sessionId: text("session_id").notNull(),
  appCredentialId: text("app_credential_id").notNull(),
  hookCredentialId: text("hook_credential_id").notNull(),
  providerId: text("provider_id").notNull(),
  returnOrigin: text("return_origin").notNull(),
  replacement: boolean("replacement").notNull().default(false),
  status: text("status").notNull(),
  appSlug: text("app_slug"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export async function migrateGithubManifest(db: DB["db"]): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS corbits_github_manifest_state (
      state_hash text PRIMARY KEY,
      tenant_id text NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
      principal_id text NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
      session_id text NOT NULL,
      app_credential_id text NOT NULL,
      hook_credential_id text NOT NULL,
      provider_id text NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
      return_origin text NOT NULL,
      replacement boolean NOT NULL DEFAULT false,
      status text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      app_slug text,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS corbits_github_manifest_expiry_idx ON corbits_github_manifest_state (expires_at)`);
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function safeOrigin(value: string): string {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.origin !== value || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error("portalOrigin must be an HTTPS origin (or localhost for development)");
  }
  return url.origin;
}

export function validGithubProvider(value: { plugin: string; apiBaseUrl: string | null }, githubApiOrigin: string): boolean {
  return value.plugin === "http" && value.apiBaseUrl === githubApiOrigin;
}

export function validManifestMutationRequest(req: Request, trustedOrigins: ReadonlySet<string>): boolean {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return false;
  const origin = req.headers.get("origin");
  if (origin === null || !trustedOrigins.has(origin)) return false;
  const fetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();
  return fetchSite !== "cross-site";
}

export async function authorizeCanonicalCredentialWrite(
  authorizeCredential: AuthorizeCredential,
  principalId: string,
  tenantId: string,
  existing: Array<{ id: string; name: string }>,
): Promise<boolean> {
  if (existing.length === 0) return authorizeCredential(principalId, tenantId, "credential:*", "create");
  const app = existing.find((row) => row.name === "github");
  const hook = existing.find((row) => row.name === "github-hook");
  if (!app || !hook || existing.length !== 2) return false;
  const decisions = await Promise.all([
    authorizeCredential(principalId, tenantId, `credential:${app.id}`, "manage"),
    authorizeCredential(principalId, tenantId, `credential:${hook.id}`, "manage"),
  ]);
  return decisions.every(Boolean);
}

type CanonicalCredentialRow = { id: string; name: string };
type ManifestWriteState = { appCredentialId: string; hookCredentialId: string; replacement: boolean };

export async function prepareCanonicalManifestWrite(
  state: ManifestWriteState,
  existing: CanonicalCredentialRow[],
  conversion: ManifestConversion,
  cipher: CredentialCipher,
) {
  const app = existing.find((row) => row.name === "github");
  const hook = existing.find((row) => row.name === "github-hook");
  if (state.replacement) {
    if (existing.length !== 2 || app?.id !== state.appCredentialId || hook?.id !== state.hookCredentialId) {
      throw new Error("canonical credential identity changed during manifest setup");
    }
  } else if (existing.length !== 0) {
    throw new Error("canonical credentials appeared during manifest setup");
  }
  const appCredentialId = app?.id ?? state.appCredentialId;
  const hookCredentialId = hook?.id ?? state.hookCredentialId;
  const appSecret = JSON.stringify({ appId: String(conversion.id), privateKey: conversion.pem.trim() });
  const encryptedApp = await cipher.encrypt(appSecret, credentialAad(appCredentialId, "secret"));
  const encryptedHook = await cipher.encrypt(conversion.webhook_secret, credentialAad(hookCredentialId, "secret"));
  return {
    replacement: state.replacement,
    values: [
      { id: appCredentialId, name: "github", secret: encryptedApp, metadata: { appSlug: conversion.slug } },
      { id: hookCredentialId, name: "github-hook", secret: encryptedHook, metadata: { webhook: { verify: "standard-webhooks", workflow: "pr-triage" } } },
    ] as const,
  };
}

const StartBody = type({ portalOrigin: "string", replace: "boolean", "restart?": "boolean" });

export function pendingSetupAction(
  pending: { principalId: string; status: string; expiresAt: Date },
  principalId: string,
  restart: boolean,
  now: Date,
): "replace" | "expired" | "owned" | "other" {
  if (pending.expiresAt.getTime() <= now.getTime()) return "expired";
  if (pending.principalId !== principalId) return "other";
  if (restart && pending.status === "pending") return "replace";
  return "owned";
}

function currentDate(): Date {
  return new Date();
}

export function createGithubManifestIntegration({
  db, cipher, getSession, authorizeCredential, trustedPortalOrigins, githubApiOrigin, publicOrigin, fetchImpl = fetch, now = currentDate,
}: {
  db: DB["db"];
  cipher: CredentialCipher;
  getSession: GetSession;
  authorizeCredential: AuthorizeCredential;
  trustedPortalOrigins: readonly string[];
  githubApiOrigin: string;
  /** The hub's public origin; behind a TLS proxy the request URL is not. */
  publicOrigin: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  async function canWriteCredentials(principalId: string, tenantId: string, existing: Array<{ id: string; name: string }>): Promise<boolean> {
    return authorizeCanonicalCredentialWrite(authorizeCredential, principalId, tenantId, existing);
  }
  const store: ManifestCompletionStore = {
    async claim(stateHash, identity) {
      return db.transaction(async function claimPending(tx): Promise<ClaimResult> {
        const [row] = await tx.select().from(githubManifestState)
          .where(eq(githubManifestState.stateHash, stateHash)).for("update");
        if (!row) return { kind: "rejected", reason: "not_found" };
        if (row.tenantId !== identity.tenantId || row.principalId !== identity.principalId || row.sessionId !== identity.sessionId) {
          return { kind: "rejected", reason: "identity_mismatch" };
        }
        if (row.expiresAt.getTime() <= now().getTime()) return { kind: "rejected", reason: "expired" };
        if (row.status !== "pending") return { kind: "rejected", reason: row.status as "completed" | "processing" | "failed" };
        await tx.update(githubManifestState).set({ status: "processing", updatedAt: now() })
          .where(eq(githubManifestState.stateHash, stateHash));
        return { kind: "claimed", value: {
          stateHash, tenantId: row.tenantId, principalId: row.principalId, sessionId: row.sessionId,
          appCredentialId: row.appCredentialId, hookCredentialId: row.hookCredentialId, returnOrigin: row.returnOrigin,
          replacement: row.replacement,
        } };
      });
    },
    async commit(pending, conversion) {
      await db.transaction(async function commitCredentials(tx) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pending.tenantId}))`);
        const [state] = await tx.select().from(githubManifestState)
          .where(and(eq(githubManifestState.stateHash, pending.stateHash), eq(githubManifestState.status, "processing"))).for("update");
        if (!state) throw new Error("manifest state is not processing");
        const [githubProvider] = await tx.select().from(provider).where(and(eq(provider.id, state.providerId), eq(provider.tenantId, pending.tenantId), eq(provider.name, "github"))).for("update");
        if (!githubProvider || !validGithubProvider(githubProvider, githubApiOrigin)) throw new Error("canonical GitHub provider changed");
        const existing = await tx.select().from(credential).where(and(
          eq(credential.tenantId, pending.tenantId),
          sql`${credential.name} IN ('github', 'github-hook')`,
        )).for("update");
        const prepared = await prepareCanonicalManifestWrite(state, existing, conversion, cipher);
        const stamp = now();
        for (const value of prepared.values) {
          if (prepared.replacement) {
            await tx.update(credential).set({ secret: value.secret, providerId: state.providerId, status: "active", metadata: value.metadata, updatedAt: stamp })
              .where(and(eq(credential.id, value.id), eq(credential.tenantId, pending.tenantId), eq(credential.name, value.name)));
          } else {
            await tx.insert(credential).values({
              id: value.id, tenantId: pending.tenantId, principalId: null, providerId: state.providerId,
              oauthClientId: null, name: value.name, type: "api_key", description: null,
              secret: value.secret, refreshSecret: null, scopes: null, expiresAt: null,
              status: "active", metadata: value.metadata, createdAt: stamp, updatedAt: stamp,
            });
          }
        }
        await tx.update(githubManifestState).set({ status: "completed", appSlug: conversion.slug, updatedAt: stamp })
          .where(eq(githubManifestState.stateHash, pending.stateHash));
      });
    },
    async release(pending, retryable) {
      await db.update(githubManifestState).set({ status: retryable ? "pending" : "failed", updatedAt: now() })
        .where(and(eq(githubManifestState.stateHash, pending.stateHash), eq(githubManifestState.status, "processing")));
    },
  };

  function exchange(code: string): Promise<ManifestConversion> {
    return exchangeGithubManifest(code, githubApiOrigin, fetchImpl);
  }

  async function sessionAndPrincipal(req: Request, tenantId: string) {
    const session = await getSession(req.headers);
    if (!session) return null;
    const row = await db.query.principal.findFirst({
      where: and(eq(principal.tenantId, tenantId), eq(principal.kind, "user"), eq(principal.refId, session.user.id), eq(principal.status, "active")),
    });
    return row ? { session, principal: row } : null;
  }

  async function start(req: Request, tenantId: string): Promise<Response> {
    const trustedOrigins = new Set([new URL(req.url).origin, ...trustedPortalOrigins]);
    if (!validManifestMutationRequest(req, trustedOrigins)) return securedJson({ error: "forbidden" }, 403);
    const auth = await sessionAndPrincipal(req, tenantId);
    if (!auth) return securedJson({ error: "unauthorized" }, 401);
    let body: typeof StartBody.infer;
    try { body = StartBody.assert(await req.json()); } catch { return securedJson({ error: "invalid_request" }, 400); }
    let portalOrigin: string;
    try { portalOrigin = safeOrigin(body.portalOrigin); } catch { return securedJson({ error: "invalid_request" }, 400); }
    if (!trustedOrigins.has(portalOrigin)) return securedJson({ error: "forbidden" }, 403);
    const state = randomBytes(32).toString("hex");
    const callbackUrl = `${publicOrigin}${GITHUB_MANIFEST_CALLBACK_PATH}`;
    const stamp = now();
    const reservation = await db.transaction(async function reserveSetup(tx) {
      // One live reservation per tenant prevents two fresh starts from choosing
      // different IDs for the same canonical credential names.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`);
      const [live] = await tx.select().from(githubManifestState).where(and(
        eq(githubManifestState.tenantId, tenantId),
        sql`${githubManifestState.status} IN ('pending', 'processing')`,
        gt(githubManifestState.expiresAt, stamp),
      )).limit(1);
      if (live) {
        const action = pendingSetupAction(live, auth.principal.id, body.restart ?? false, stamp);
        if (action !== "replace" && action !== "expired") {
          return { error: "setup_in_progress", owned: action === "owned" } as const;
        }
        await tx.delete(githubManifestState).where(and(
          eq(githubManifestState.stateHash, live.stateHash),
          eq(githubManifestState.status, "pending"),
          eq(githubManifestState.principalId, auth.principal.id),
        ));
      }
      const [githubProvider] = await tx.select().from(provider).where(and(eq(provider.tenantId, tenantId), eq(provider.name, "github"))).limit(1);
      if (!githubProvider) return { error: "github_provider_missing" } as const;
      if (!validGithubProvider(githubProvider, githubApiOrigin)) return { error: "github_provider_invalid" } as const;
      const existing = await tx.select().from(credential).where(and(eq(credential.tenantId, tenantId), sql`${credential.name} IN ('github', 'github-hook')`));
      if (!await canWriteCredentials(auth.principal.id, tenantId, existing)) return { error: "forbidden" } as const;
      if (existing.length > 0 && !body.replace) return { error: "replacement_confirmation_required" } as const;
      const appId = existing.find((row) => row.name === "github")?.id ?? generateId("credential");
      const hookId = existing.find((row) => row.name === "github-hook")?.id ?? generateId("credential");
      await tx.insert(githubManifestState).values({
        stateHash: hashState(state), tenantId, principalId: auth.principal.id, sessionId: auth.session.session.id,
        appCredentialId: appId, hookCredentialId: hookId, providerId: githubProvider.id, returnOrigin: portalOrigin,
        replacement: existing.length > 0, status: "pending", expiresAt: new Date(stamp.getTime() + GITHUB_MANIFEST_MAX_AGE_MS),
        createdAt: stamp, updatedAt: stamp,
      });
      return { hookId } as const;
    });
    if ("error" in reservation) return securedJson({
      error: reservation.error,
      ...(reservation.error === "setup_in_progress" ? { owned: reservation.owned } : {}),
    }, reservation.error === "forbidden" ? 403 : 409);
    const hookUrl = `${publicOrigin}/api/hooks/${encodeURIComponent(tenantId)}/github-hook`;
    return securedJson({ manifest: buildGithubAppManifest(portalOrigin, hookUrl, callbackUrl), state }, 201);
  }

  async function cancel(req: Request, tenantId: string): Promise<Response> {
    const trustedOrigins = new Set([new URL(req.url).origin, ...trustedPortalOrigins]);
    if (!validManifestMutationRequest(req, trustedOrigins)) return securedJson({ error: "forbidden" }, 403);
    const auth = await sessionAndPrincipal(req, tenantId);
    if (!auth) return securedJson({ error: "unauthorized" }, 401);
    const deleted = await db.delete(githubManifestState).where(and(
      eq(githubManifestState.tenantId, tenantId),
      eq(githubManifestState.principalId, auth.principal.id),
      eq(githubManifestState.status, "pending"),
    )).returning({ stateHash: githubManifestState.stateHash });
    return securedJson({ cancelled: deleted.length > 0 }, 200);
  }

  async function callback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const session = await getSession(req.headers);
    if (!session || !state || !code) return securedHtml("GitHub setup could not be verified.", 401);
    const [pending] = await db.select().from(githubManifestState).where(eq(githubManifestState.stateHash, hashState(state)));
    if (!pending) return securedHtml("GitHub setup could not be verified.", 400);
    const auth = await sessionAndPrincipal(req, pending.tenantId);
    const identity = auth
      ? { sessionId: auth.session.session.id, principalId: auth.principal.id, tenantId: pending.tenantId }
      : { sessionId: session.session.id, principalId: "", tenantId: pending.tenantId };
    if (auth) {
      const existing = pending.replacement
        ? [{ id: pending.appCredentialId, name: "github" }, { id: pending.hookCredentialId, name: "github-hook" }]
        : [];
      if (!await canWriteCredentials(auth.principal.id, pending.tenantId, existing)) {
        return securedHtml("You do not have permission to complete GitHub setup.", 403);
      }
    }
    const currentProvider = await db.query.provider.findFirst({
      where: and(eq(provider.id, pending.providerId), eq(provider.tenantId, pending.tenantId), eq(provider.name, "github")),
    });
    if (!currentProvider || !validGithubProvider(currentProvider, githubApiOrigin)) {
      return securedHtml("GitHub setup provider configuration is invalid.", 409);
    }
    const result = await completeManifest({ state, code, identity, store, exchange });
    if (result.kind === "completed") {
      const target = new URL("/connect", result.returnOrigin);
      target.searchParams.set("github", "connected");
      target.searchParams.set("app", result.appSlug);
      return new Response(null, { status: 303, headers: { ...manifestSecurityHeaders(), Location: target.toString(), "Cache-Control": "no-store" } });
    }
    return securedHtml(result.kind === "failed" && result.retryable
      ? "GitHub is temporarily unavailable. Reload this page to retry."
      : "GitHub setup could not be completed. Return to Corbits and start again.", result.kind === "failed" && result.retryable ? 503 : 400);
  }

  return { start, cancel, callback };
}

function securedJson(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { ...manifestSecurityHeaders(), "Cache-Control": "no-store" } });
}

function securedHtml(message: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>GitHub setup</title><p>${message}</p>`, {
    status,
    headers: { ...manifestSecurityHeaders(), "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" },
  });
}
