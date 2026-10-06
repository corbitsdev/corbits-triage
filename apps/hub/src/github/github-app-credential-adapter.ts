import { createHash, createSign } from "node:crypto";
import { type } from "arktype";

export const DEFAULT_GITHUB_API_ORIGIN = "https://api.github.com";
const REFRESH_MARGIN_MS = 5 * 60_000;
export const INSTALLATION_SELECTOR_HEADER = "x-corbits-github-installation-id";

const GithubAppCredential = type({
  appId: "string > 0",
  "installationId?": "string > 0",
  privateKey: "string > 0",
});

const Installation = type({
  id: "number",
});

const InstallationToken = type({
  token: "string > 0",
  expires_at: "string > 0",
});

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type AppCredential = typeof GithubAppCredential.infer;

export type GithubAppCredentialFetchOptions = {
  readonly apiOrigin: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
};

type CachedToken = {
  readonly token: string;
  readonly expiresAt: number;
};

function parseAppCredential(raw: string): AppCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GitHub App credential must be App JSON; raw tokens are not accepted in production");
  }
  const credential = GithubAppCredential(parsed);
  if (credential instanceof type.errors) {
    throw new Error(`GitHub App credential failed validation: ${credential.summary}`);
  }
  return {
    ...credential,
    privateKey: credential.privateKey.replace(/\\n/g, "\n"),
  };
}

function isGithubAppJson(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === "object" && ("appId" in value || "privateKey" in value);
  } catch {
    return false;
  }
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function appJwt(credential: AppCredential, now: number): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iat: issuedAt,
    exp: issuedAt + 600,
    iss: credential.appId,
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(credential.privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

function credentialFingerprint(credential: AppCredential): string {
  const keyFingerprint = createHash("sha256")
    .update(credential.privateKey)
    .digest("base64url");
  return `${credential.appId}:${keyFingerprint}`;
}

function installationPath(url: URL): string {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "repos" && parts.length >= 3) {
    return `/repos/${encodeURIComponent(parts[1])}/${encodeURIComponent(parts[2])}/installation`;
  }
  if (parts[0] === "orgs" && parts.length >= 2) {
    return `/orgs/${encodeURIComponent(parts[1])}/installation`;
  }
  throw new Error("GitHub App credential requires a repository or organization target");
}

/**
 * Trusted sidecar transport adapter for the stock origin-pinned HTTP provider.
 * The provider injects the current vault material as a bearer immediately
 * before calling this function. App JSON is consumed here, exchanged for an
 * installation token, and never passed to the network or exposed to the tool.
 */
export function createGithubAppCredentialFetch({
  apiOrigin,
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
}: GithubAppCredentialFetchOptions): FetchLike {
  const cache = new Map<string, CachedToken>();
  const pending = new Map<string, Promise<CachedToken>>();

  async function discoverInstallation(credential: AppCredential, url: URL): Promise<number> {
    const response = await fetchImpl(`${apiOrigin}${installationPath(url)}`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt(credential, now())}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "manual",
    });
    if (!response.ok) {
      throw new Error(`GitHub App installation discovery failed with ${String(response.status)}`);
    }
    const installation = Installation(await response.json());
    if (installation instanceof type.errors || !Number.isSafeInteger(installation.id) || installation.id <= 0) {
      const detail = installation instanceof type.errors ? installation.summary : "id must be a positive safe integer";
      throw new Error(`GitHub App installation response failed validation: ${detail}`);
    }
    return installation.id;
  }

  async function requestToken(credential: AppCredential, installationId: number, key: string): Promise<CachedToken> {
    const response = await fetchImpl(
      `${apiOrigin}/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${appJwt(credential, now())}`,
          "x-github-api-version": "2022-11-28",
        },
        redirect: "manual",
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub installation token mint failed with ${String(response.status)}`);
    }
    const body = InstallationToken(await response.json());
    if (body instanceof type.errors) {
      throw new Error(`GitHub installation token response failed validation: ${body.summary}`);
    }
    const expiresAt = Date.parse(body.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
      throw new Error("GitHub installation token response has an invalid expiry");
    }
    const token = { token: body.token, expiresAt };
    cache.set(key, token);
    return token;
  }

  async function mint(credential: AppCredential, installationId: number, force: boolean): Promise<CachedToken> {
    const key = `${credentialFingerprint(credential)}:${String(installationId)}`;
    const cached = cache.get(key);
    if (!force && cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return cached;
    const active = pending.get(key);
    if (!force && active) return active;

    const request = requestToken(credential, installationId, key);
    pending.set(key, request);
    try {
      return await request;
    } finally {
      if (pending.get(key) === request) pending.delete(key);
    }
  }

  return async function githubAppCredentialFetch(input, init) {
    const original = new Request(input, init);
    const authorization = original.headers.get("authorization");
    if (new URL(original.url).origin !== apiOrigin) {
      if (authorization?.startsWith("Bearer ") && isGithubAppJson(authorization.slice("Bearer ".length))) {
        throw new Error("GitHub App credential cannot be sent to a non-GitHub origin");
      }
      return fetchImpl(original);
    }
    if (authorization === null) return fetchImpl(original);
    if (!authorization.startsWith("Bearer ")) {
      throw new Error("GitHub App credential requires Bearer mediation");
    }
    const credential = parseAppCredential(authorization.slice("Bearer ".length));
    const url = new URL(original.url);
    if (url.pathname === "/app" || url.pathname === "/app/installations") {
      const headers = new Headers(original.headers);
      headers.delete(INSTALLATION_SELECTOR_HEADER);
      headers.set("authorization", `Bearer ${appJwt(credential, now())}`);
      return fetchImpl(new Request(original, { headers, redirect: "manual" }));
    }
    const selected = original.headers.get(INSTALLATION_SELECTOR_HEADER);
    const installationId = selected === null
      ? await discoverInstallation(credential, url)
      : Number(selected);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error("GitHub installation selector must be a positive safe integer");
    }

    async function send(force: boolean): Promise<Response> {
      const { token } = await mint(credential, installationId, force);
      const request = original.clone();
      const headers = new Headers(request.headers);
      headers.delete(INSTALLATION_SELECTOR_HEADER);
      headers.set("authorization", `Bearer ${token}`);
      return fetchImpl(new Request(request, { headers, redirect: "manual" }));
    }

    const response = await send(false);
    return response.status === 401 ? send(true) : response;
  };
}
