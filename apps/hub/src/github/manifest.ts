import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { type } from "arktype";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { GITHUB_HOOK_HEADERS, xHubHookMetadata } from "@corbits/common/hook-metadata";
import { TRIAGE_LISTENERS } from "@corbits/triage-contracts";
import { generateId } from "@intx/hub-common";
import { grantAdminGithub } from "./admin-github-grant.js";
import { storeAppKey } from "./app-key.js";
import { ensureTriageRole } from "./automation.js";

const { credential, principal, provider } = schema;

type SessionResult = {
  user: { id: string };
  session: { id: string };
};
type GetSession = (headers: Headers) => Promise<SessionResult | null>;
type AuthorizeCredential = (principalId: string, tenantId: string, resource: string, action: "create" | "manage") => Promise<boolean>;

export const GITHUB_MANIFEST_PATH = "/api/integrations/github-manifest";
export const GITHUB_MANIFEST_CALLBACK_PATH = `${GITHUB_MANIFEST_PATH}/callback`;
const GITHUB_MANIFEST_MAX_AGE_MS = 10 * 60_000;

const GITHUB_APP_PERMISSIONS = {
  checks: "read",
  contents: "write",
  issues: "write",
  members: "read",
  metadata: "read",
  pull_requests: "write",
} as const;

const GITHUB_APP_EVENTS = [
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "check_run",
  "check_suite",
  "push",
] as const;

export type GithubAppManifest = {
  name: string;
  url: string;
  /** Absent for a hub on localhost: GitHub refuses a manifest whose hook URL it cannot reach, so the App is created without a webhook. */
  hook_attributes?: { url: string; active: true };
  redirect_url: string;
  public: false;
  default_permissions: typeof GITHUB_APP_PERMISSIONS;
  default_events: typeof GITHUB_APP_EVENTS;
  request_oauth_on_install: false;
  setup_url: string;
  setup_on_update: true;
};

function buildGithubAppManifest(portalOrigin: string, hookUrl: string | null, callbackUrl: string): GithubAppManifest {
  return {
    name: "Corbits Triage",
    url: portalOrigin,
    ...(hookUrl === null ? {} : { hook_attributes: { url: hookUrl, active: true as const } }),
    redirect_url: callbackUrl,
    public: false,
    default_permissions: GITHUB_APP_PERMISSIONS,
    default_events: GITHUB_APP_EVENTS,
    request_oauth_on_install: false,
    // GitHub sends the browser back here after the App is installed or its repositories change.
    setup_url: `${portalOrigin}/`,
    setup_on_update: true,
  };
}

function manifestSecurityHeaders(): Record<string, string> {
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
  /** Null when the App was created without a webhook. */
  "webhook_secret?": "(string > 0) | null",
});
export type ManifestConversion = typeof ManifestConversion.infer;

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

const ManifestState = type({
  tenantId: "string > 0",
  principalId: "string > 0",
  userId: "string > 0",
  sessionId: "string > 0",
  appCredentialId: "string > 0",
  hookCredentialId: "string > 0",
  providerId: "string > 0",
  /** The replaced credentials' last updates; a replacement commits only while both are unchanged. Null for a fresh setup. */
  replaces: type({ appUpdatedAt: "number.integer", hookUpdatedAt: "number.integer" }).or("null"),
  nonce: "string > 0",
  expiresAt: "number.integer",
});
export type ManifestState = typeof ManifestState.infer;

const STATE_KEY_LABEL = "corbits-triage/github-manifest-state";

/** A key of its own, so a manifest state signature is never valid anywhere else the secret is used. */
export function manifestStateKey(secret: string): Buffer {
  const bytes = Buffer.from(secret, "hex");
  if (bytes.length !== 32) throw new Error("the manifest state secret must be 32 bytes of hexadecimal");
  return createHmac("sha256", bytes).update(STATE_KEY_LABEL).digest();
}

function stateMac(key: Uint8Array, payload: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

export function signManifestState(key: Uint8Array, state: ManifestState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${payload}.${stateMac(key, payload).toString("base64url")}`;
}

export function verifyManifestState(key: Uint8Array, token: string, now: Date): ManifestState | null {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = stateMac(key, payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const state = ManifestState(decoded);
  if (state instanceof type.errors || state.expiresAt <= now.getTime()) return null;
  return state;
}

function loopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function safeOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost(url.hostname)))) {
    throw new Error("portalOrigin must be an HTTPS origin (or localhost for development)");
  }
  return url.origin;
}

/**
 * The App's webhook URL, or null when the hub is on localhost. GitHub validates
 * the hook URL as it reads the manifest and refuses one it cannot reach over
 * the public internet, so a local hub registers the App without a webhook and
 * finds pull requests by polling instead.
 */
export function manifestHookUrl(publicOrigin: string, tenantId: string): string | null {
  if (loopbackHost(new URL(publicOrigin).hostname)) return null;
  return `${publicOrigin}/api/hooks/${encodeURIComponent(tenantId)}/github-hook`;
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
  const appJson = JSON.stringify({ appId: String(conversion.id), privateKey: conversion.pem.trim() });
  // The App is not installed yet, so the credential workflows bind holds no token; the key goes to the hub-only one.
  const noToken = await cipher.encrypt("", credentialAad(appCredentialId, "secret"));
  // Without a webhook GitHub issues no secret; the hub makes one so the hook credential is complete if a webhook is added later.
  const hookSecret = conversion.webhook_secret ?? randomBytes(32).toString("hex");
  const encryptedHook = await cipher.encrypt(hookSecret, credentialAad(hookCredentialId, "secret"));
  return {
    replacement: state.replacement,
    appJson,
    values: [
      { id: appCredentialId, name: "github", secret: noToken, metadata: { appSlug: conversion.slug } },
      { id: hookCredentialId, name: "github-hook", secret: encryptedHook, metadata: xHubHookMetadata(TRIAGE_LISTENERS.github, GITHUB_HOOK_HEADERS) },
    ] as const,
  };
}

export const StartBody = type({ portalOrigin: "string", replace: "boolean" });

function unchangedSince(replaces: { appUpdatedAt: number; hookUpdatedAt: number }, rows: Array<{ name: string; updatedAt: Date }>): boolean {
  return rows.find((row) => row.name === "github")?.updatedAt.getTime() === replaces.appUpdatedAt
    && rows.find((row) => row.name === "github-hook")?.updatedAt.getTime() === replaces.hookUpdatedAt;
}

const SETUP_FAILED = "GitHub setup could not be completed. Return to Corbits and start again.";

function currentDate(): Date {
  return new Date();
}

export function createGithubManifestIntegration({
  db, cipher, getSession, authorizeCredential, stateSecret, trustedPortalOrigins, githubApiOrigin, publicOrigin, fetchImpl = fetch, now = currentDate,
}: {
  db: DB["db"];
  cipher: CredentialCipher;
  getSession: GetSession;
  authorizeCredential: AuthorizeCredential;
  /** Hex secret the state signing key is derived from. */
  stateSecret: string;
  trustedPortalOrigins: readonly string[];
  githubApiOrigin: string;
  /** The hub's public origin; behind a TLS proxy the request URL is not. */
  publicOrigin: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  const stateKey = manifestStateKey(stateSecret);

  async function canWriteCredentials(principalId: string, tenantId: string, existing: Array<{ id: string; name: string }>): Promise<boolean> {
    return authorizeCanonicalCredentialWrite(authorizeCredential, principalId, tenantId, existing);
  }

  /**
   * GitHub converts a code once; on top of that, under the tenant lock a fresh
   * setup inserts only while no credentials exist and a replacement writes only
   * while both credentials' updatedAt are unchanged since start, so a state
   * commits once.
   */
  async function commit(state: ManifestState, conversion: ManifestConversion): Promise<void> {
    await db.transaction(async function commitCredentials(tx) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${state.tenantId}))`);
      const [githubProvider] = await tx.select().from(provider).where(and(eq(provider.id, state.providerId), eq(provider.tenantId, state.tenantId), eq(provider.name, "github"))).for("update");
      if (!githubProvider || !validGithubProvider(githubProvider, githubApiOrigin)) throw new Error("canonical GitHub provider changed");
      const existing = await tx.select().from(credential).where(and(
        eq(credential.tenantId, state.tenantId),
        sql`${credential.name} IN ('github', 'github-hook')`,
      )).for("update");
      const prepared = await prepareCanonicalManifestWrite({ ...state, replacement: state.replaces !== null }, existing, conversion, cipher);
      if (state.replaces && !unchangedSince(state.replaces, existing)) throw new Error("canonical credentials changed during manifest setup");
      const stamp = now();
      for (const value of prepared.values) {
        if (prepared.replacement) {
          await tx.update(credential).set({ secret: value.secret, providerId: state.providerId, status: "active", metadata: value.metadata, expiresAt: null, updatedAt: stamp })
            .where(and(eq(credential.id, value.id), eq(credential.tenantId, state.tenantId), eq(credential.name, value.name)));
        } else {
          await tx.insert(credential).values({
            id: value.id, tenantId: state.tenantId, principalId: null, providerId: state.providerId,
            oauthClientId: null, name: value.name, type: "api_key", description: null,
            secret: value.secret, refreshSecret: null, scopes: null, expiresAt: null,
            status: "active", metadata: value.metadata, createdAt: stamp, updatedAt: stamp,
          });
        }
      }
      await storeAppKey(tx, cipher, { tenantId: state.tenantId, appJson: prepared.appJson });
      await grantAdminGithub(tx, state.tenantId, state.appCredentialId, stamp);
      await ensureTriageRole(tx, state.tenantId, stamp);
    });
  }

  async function activePrincipal(userId: string, tenantId: string) {
    return db.query.principal.findFirst({
      where: and(eq(principal.tenantId, tenantId), eq(principal.kind, "user"), eq(principal.refId, userId), eq(principal.status, "active")),
    });
  }

  async function start(req: Request, tenantId: string): Promise<Response> {
    const trustedOrigins = new Set([new URL(req.url).origin, ...trustedPortalOrigins]);
    if (!validManifestMutationRequest(req, trustedOrigins)) return securedJson({ error: "forbidden" }, 403);
    const session = await getSession(req.headers);
    const member = session ? await activePrincipal(session.user.id, tenantId) : undefined;
    if (!session || !member) return securedJson({ error: "unauthorized" }, 401);
    let body: typeof StartBody.infer;
    try { body = StartBody.assert(await req.json()); } catch { return securedJson({ error: "invalid_request" }, 400); }
    let portalOrigin: string;
    try { portalOrigin = safeOrigin(body.portalOrigin); } catch { return securedJson({ error: "invalid_request" }, 400); }
    if (!trustedOrigins.has(portalOrigin)) return securedJson({ error: "forbidden" }, 403);
    const [githubProvider] = await db.select().from(provider).where(and(eq(provider.tenantId, tenantId), eq(provider.name, "github"))).limit(1);
    if (!githubProvider) return securedJson({ error: "github_provider_missing" }, 409);
    if (!validGithubProvider(githubProvider, githubApiOrigin)) return securedJson({ error: "github_provider_invalid" }, 409);
    const existing = await db.select().from(credential).where(and(eq(credential.tenantId, tenantId), sql`${credential.name} IN ('github', 'github-hook')`));
    if (!await canWriteCredentials(member.id, tenantId, existing)) return securedJson({ error: "forbidden" }, 403);
    if (existing.length > 0 && !body.replace) return securedJson({ error: "replacement_confirmation_required" }, 409);
    const app = existing.find((row) => row.name === "github");
    const hook = existing.find((row) => row.name === "github-hook");
    const state = signManifestState(stateKey, {
      tenantId,
      principalId: member.id,
      userId: session.user.id,
      sessionId: session.session.id,
      appCredentialId: app?.id ?? generateId("credential"),
      hookCredentialId: hook?.id ?? generateId("credential"),
      providerId: githubProvider.id,
      replaces: app && hook ? { appUpdatedAt: app.updatedAt.getTime(), hookUpdatedAt: hook.updatedAt.getTime() } : null,
      nonce: randomBytes(16).toString("base64url"),
      expiresAt: now().getTime() + GITHUB_MANIFEST_MAX_AGE_MS,
    });
    const callbackUrl = `${publicOrigin}${GITHUB_MANIFEST_CALLBACK_PATH}`;
    const hookUrl = manifestHookUrl(publicOrigin, tenantId);
    return securedJson({ manifest: buildGithubAppManifest(portalOrigin, hookUrl, callbackUrl), state }, 201);
  }

  async function callback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const token = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const session = await getSession(req.headers);
    if (!session || !token || !code) return securedHtml("GitHub setup could not be verified.", 401);
    const state = verifyManifestState(stateKey, token, now());
    if (!state || state.userId !== session.user.id || state.sessionId !== session.session.id) return securedHtml("GitHub setup could not be verified.", 400);
    const member = await activePrincipal(session.user.id, state.tenantId);
    if (member?.id !== state.principalId) return securedHtml("GitHub setup could not be verified.", 400);
    const existing = state.replaces
      ? [{ id: state.appCredentialId, name: "github" }, { id: state.hookCredentialId, name: "github-hook" }]
      : [];
    if (!await canWriteCredentials(member.id, state.tenantId, existing)) {
      return securedHtml("You do not have permission to complete GitHub setup.", 403);
    }
    const currentProvider = await db.query.provider.findFirst({
      where: and(eq(provider.id, state.providerId), eq(provider.tenantId, state.tenantId), eq(provider.name, "github")),
    });
    if (!currentProvider || !validGithubProvider(currentProvider, githubApiOrigin)) {
      return securedHtml("GitHub setup provider configuration is invalid.", 409);
    }
    let conversion: ManifestConversion;
    try {
      conversion = await exchangeGithubManifest(code, githubApiOrigin, fetchImpl);
    } catch (cause) {
      if (cause instanceof GithubExchangeError && !cause.retryable) return securedHtml(SETUP_FAILED, 400);
      return securedHtml("GitHub is temporarily unavailable. Reload this page to retry.", 503);
    }
    try {
      await commit(state, conversion);
    } catch {
      return securedHtml(SETUP_FAILED, 400);
    }
    // Straight on to choosing repositories; once they are chosen, GitHub sends the browser to the App's setup_url.
    const install = `https://github.com/apps/${encodeURIComponent(conversion.slug)}/installations/new`;
    return new Response(null, { status: 303, headers: { ...manifestSecurityHeaders(), Location: install, "Cache-Control": "no-store" } });
  }

  return { start, callback };
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
