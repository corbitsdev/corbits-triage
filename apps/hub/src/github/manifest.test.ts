import { describe, expect, test } from "bun:test";
import { credentialAad, type CredentialCipher } from "@intx/types";
import {
  authorizeCanonicalCredentialWrite,
  createGithubManifestIntegration,
  exchangeGithubManifest,
  manifestStateKey,
  prepareCanonicalManifestWrite,
  signManifestState,
  validGithubProvider,
  validManifestMutationRequest,
  verifyManifestState,
  type ManifestState,
} from "./manifest.js";

const STATE_SECRET = "11".repeat(32);
const STATE_KEY = manifestStateKey(STATE_SECRET);
const NOW = new Date("2026-03-10T12:00:00Z");

const setup: ManifestState = {
  tenantId: "tnt_one",
  principalId: "prn_one",
  userId: "usr_one",
  sessionId: "ses_one",
  appCredentialId: "crd_app",
  hookCredentialId: "crd_hook",
  providerId: "prv_github",
  replaces: { appUpdatedAt: NOW.getTime() - 60_000, hookUpdatedAt: NOW.getTime() - 60_000 },
  nonce: "nonce",
  expiresAt: NOW.getTime() + 60_000,
};

const conversion = {
  id: 42,
  slug: "corbits-triage-acme",
  pem: "PRIVATE-KEY-SENTINEL",
  webhook_secret: "WEBHOOK-SECRET-SENTINEL",
};

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_PROVIDER = { id: "prv_github", tenantId: "tnt_one", name: "github", plugin: "http", apiBaseUrl: GITHUB_API_ORIGIN };
const START_URL = "https://hub.example/api/integrations/github-manifest/tnt_one/start";

function fixedNow(): Date {
  return NOW;
}

async function signedInSession() {
  return { user: { id: "usr_one" }, session: { id: "ses_one" } };
}

async function activeMember() {
  return { id: "prn_one" };
}

async function deny(): Promise<boolean> {
  return false;
}

function noPreconnect(): void {}

/** Drizzle builders are awaited directly or via `.limit()`; both resolve to rows. */
function rowsQuery(rows: unknown[]) {
  return {
    async limit() {
      return rows;
    },
    then(resolve: (value: unknown[]) => void) {
      resolve(rows);
    },
  };
}

/** start() selects the GitHub provider via `.limit()`, then awaits the canonical `credentials`. */
function startDb(credentials: unknown[]) {
  const results = [[GITHUB_PROVIDER], credentials];
  return {
    query: { principal: { findFirst: activeMember } },
    select() {
      return { from() { return { where() { return rowsQuery(results.shift() ?? []); } }; } };
    },
  } as never;
}

function startRequest(): Request {
  return new Request(START_URL, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://hub.example", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ portalOrigin: "https://hub.example", replace: false }),
  });
}

function callbackRequest(state: string): Request {
  return new Request(`https://hub.example/api/integrations/github-manifest/callback?state=${encodeURIComponent(state)}&code=code`);
}

function mutationRequest(headers: Bun.HeadersInit): Request {
  return new Request(START_URL, { method: "POST", headers, body: "{}" });
}

describe("GitHub manifest authorization", () => {
  test("requires create for fresh setup and manage over both canonical credentials for replacement", async () => {
    const calls: string[] = [];
    async function authorize(_principal: string, _tenant: string, resource: string, action: "create" | "manage") {
      calls.push(`${resource}:${action}`);
      return resource !== "credential:crd_hook";
    }
    expect(await authorizeCanonicalCredentialWrite(authorize, "prn_one", "tnt_one", [])).toBeTrue();
    expect(await authorizeCanonicalCredentialWrite(authorize, "prn_one", "tnt_one", [
      { id: "crd_app", name: "github" }, { id: "crd_hook", name: "github-hook" },
    ])).toBeFalse();
    expect(calls).toEqual(["credential:*:create", "credential:crd_app:manage", "credential:crd_hook:manage"]);
  });

  for (const [label, credentials] of [
    ["fresh setup", []],
    ["replacement", [{ id: "crd_app", name: "github" }, { id: "crd_hook", name: "github-hook" }]],
  ] as const) {
    test(`start returns 403 to a grantless member for ${label}`, async () => {
      const integration = createGithubManifestIntegration({
        db: startDb([...credentials]),
        cipher: {} as never,
        getSession: signedInSession,
        authorizeCredential: deny,
        stateSecret: STATE_SECRET,
        trustedPortalOrigins: [],
        githubApiOrigin: GITHUB_API_ORIGIN,
        publicOrigin: "https://hub.example.com",
      });
      const response = await integration.start(startRequest(), "tnt_one");
      expect(response.status).toBe(403);
    });
  }

  test("callback returns 403 without exchanging the code when replacement authority is absent", async () => {
    let exchanged = false;
    async function exchangeSpy() {
      exchanged = true;
      return Response.json(conversion);
    }
    const integration = createGithubManifestIntegration({
      db: { query: { principal: { findFirst: activeMember } } } as never,
      cipher: {} as never,
      getSession: signedInSession,
      authorizeCredential: deny,
      stateSecret: STATE_SECRET,
      trustedPortalOrigins: [],
      githubApiOrigin: GITHUB_API_ORIGIN,
      publicOrigin: "https://hub.example.com",
      fetchImpl: Object.assign(exchangeSpy, { preconnect: noPreconnect }),
      now: fixedNow,
    });
    const response = await integration.callback(callbackRequest(signManifestState(STATE_KEY, setup)));
    expect(response.status).toBe(403);
    expect(exchanged).toBeFalse();
  });

  test("requires JSON, an exact trusted Origin, and rejects cross-site mutations", () => {
    const trusted = new Set(["https://portal.example", "https://hub.example"]);
    expect(validManifestMutationRequest(mutationRequest({
      "content-type": "application/json; charset=utf-8",
      origin: "https://portal.example",
      "sec-fetch-site": "same-site",
    }), trusted)).toBe(true);
    expect(validManifestMutationRequest(mutationRequest({ "content-type": "text/plain", origin: "https://portal.example" }), trusted)).toBe(false);
    expect(validManifestMutationRequest(mutationRequest({
      "content-type": "application/json",
      origin: "https://portal.example.attacker.test",
    }), trusted)).toBe(false);
    expect(validManifestMutationRequest(mutationRequest({
      "content-type": "application/json",
      origin: "https://portal.example",
      "sec-fetch-site": "cross-site",
    }), trusted)).toBe(false);
  });

  test("accepts only the canonical origin-pinned GitHub HTTP provider", () => {
    expect(validGithubProvider({ plugin: "http", apiBaseUrl: GITHUB_API_ORIGIN }, GITHUB_API_ORIGIN)).toBe(true);
    expect(validGithubProvider({ plugin: "http", apiBaseUrl: "https://api.github.com/" }, GITHUB_API_ORIGIN)).toBe(false);
    expect(validGithubProvider({ plugin: "http", apiBaseUrl: "https://attacker.example" }, GITHUB_API_ORIGIN)).toBe(false);
    expect(validGithubProvider({ plugin: "oauth", apiBaseUrl: GITHUB_API_ORIGIN }, GITHUB_API_ORIGIN)).toBe(false);
    expect(validGithubProvider({ plugin: "http", apiBaseUrl: GITHUB_API_ORIGIN }, "http://127.0.0.1:4001")).toBe(false);
  });

  test("exchanges the code against the configured GitHub origin", async () => {
    let seen = "";
    async function recordConversion(input: string | URL | Request) {
      seen = String(input);
      return Response.json({ id: 1, slug: "app", pem: "pem", webhook_secret: "secret" });
    }
    await expect(exchangeGithubManifest("code-1", "http://127.0.0.1:4001", Object.assign(recordConversion, { preconnect: noPreconnect })))
      .resolves.toMatchObject({ slug: "app" });
    expect(seen).toBe("http://127.0.0.1:4001/app-manifests/code-1/conversions");
  });
});

describe("GitHub manifest credential writes", () => {
  test("preserves decryptable concurrent canonical inserts instead of rewriting them with reserved-ID AAD", async () => {
    const cipher: CredentialCipher = {
      async encrypt(plaintext, aad) {
        return `${aad.length}:${aad}${plaintext}`;
      },
      async decrypt(blob, aad) {
        const separator = blob.indexOf(":");
        const length = Number(blob.slice(0, separator));
        const storedAad = blob.slice(separator + 1, separator + 1 + length);
        if (storedAad !== aad) throw new Error("AAD mismatch");
        return blob.slice(separator + 1 + length);
      },
    };
    const concurrent = [
      { id: "crd_concurrent_app", name: "github", secret: await cipher.encrypt("existing-app", credentialAad("crd_concurrent_app", "secret")) },
      { id: "crd_concurrent_hook", name: "github-hook", secret: await cipher.encrypt("existing-hook", credentialAad("crd_concurrent_hook", "secret")) },
    ];
    const before = structuredClone(concurrent);

    await expect(prepareCanonicalManifestWrite({
      appCredentialId: "crd_reserved_app",
      hookCredentialId: "crd_reserved_hook",
      replacement: false,
    }, concurrent, conversion, cipher)).rejects.toThrow("appeared during manifest setup");

    expect(concurrent).toEqual(before);
    expect(await cipher.decrypt(concurrent[0]!.secret, credentialAad(concurrent[0]!.id, "secret"))).toBe("existing-app");
    expect(await cipher.decrypt(concurrent[1]!.secret, credentialAad(concurrent[1]!.id, "secret"))).toBe("existing-hook");
  });

  test("keeps converted secrets out of credential metadata", async () => {
    const cipher: CredentialCipher = {
      async encrypt(plaintext, aad) {
        return `${aad.length}:${aad}${plaintext}`;
      },
      async decrypt(blob) {
        return blob;
      },
    };
    const prepared = await prepareCanonicalManifestWrite({
      appCredentialId: "crd_app",
      hookCredentialId: "crd_hook",
      replacement: false,
    }, [], conversion, cipher);
    expect(prepared.values[0]).toMatchObject({ name: "github", metadata: { appSlug: conversion.slug } });
    expect(prepared.values[1]).toMatchObject({
      name: "github-hook",
      metadata: { webhook: { verify: "x-hub-signature", workflow: "pr-triage-github", headers: { signature: "x-hub-signature-256", event: "x-github-event", delivery: "x-github-delivery" } } },
    });
    const metadata = JSON.stringify(prepared.values.map((value) => value.metadata));
    expect(metadata).not.toContain("PRIVATE-KEY-SENTINEL");
    expect(metadata).not.toContain("WEBHOOK-SECRET-SENTINEL");
  });
});

describe("GitHub manifest state", () => {
  test("round-trips a signed state", () => {
    expect(verifyManifestState(STATE_KEY, signManifestState(STATE_KEY, setup), NOW)).toEqual(setup);
  });

  test("refuses tampered, foreign-key and expired states", () => {
    const token = signManifestState(STATE_KEY, setup);
    const [, signature] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...setup, tenantId: "tnt_other" })).toString("base64url")}.${signature}`;
    expect(verifyManifestState(STATE_KEY, forged, NOW)).toBeNull();
    expect(verifyManifestState(STATE_KEY, `${token}x`, NOW)).toBeNull();
    expect(verifyManifestState(manifestStateKey("22".repeat(32)), token, NOW)).toBeNull();
    expect(verifyManifestState(STATE_KEY, token, new Date(setup.expiresAt))).toBeNull();
  });

  test("callback refuses another user's state without touching the database or GitHub", async () => {
    let exchanged = false;
    async function exchangeSpy() {
      exchanged = true;
      return Response.json(conversion);
    }
    async function otherUser() {
      return { user: { id: "usr_other" }, session: { id: "ses_other" } };
    }
    const integration = createGithubManifestIntegration({
      db: {} as never,
      cipher: {} as never,
      getSession: otherUser,
      authorizeCredential: deny,
      stateSecret: STATE_SECRET,
      trustedPortalOrigins: [],
      githubApiOrigin: GITHUB_API_ORIGIN,
      publicOrigin: "https://hub.example.com",
      fetchImpl: Object.assign(exchangeSpy, { preconnect: noPreconnect }),
      now: fixedNow,
    });
    const response = await integration.callback(callbackRequest(signManifestState(STATE_KEY, setup)));
    expect(response.status).toBe(400);
    expect(exchanged).toBeFalse();
  });
});
