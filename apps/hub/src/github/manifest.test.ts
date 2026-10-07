import { describe, expect, test } from "bun:test";
import { credentialAad, type CredentialCipher } from "@intx/types";
import {
  authorizeCanonicalCredentialWrite,
  completeManifest,
  createGithubManifestIntegration,
  exchangeGithubManifest,
  pendingSetupAction,
  prepareCanonicalManifestWrite,
  validGithubProvider,
  validManifestMutationRequest,
  type ClaimedManifest,
  type ManifestCompletionStore,
} from "./manifest.js";

const claim: ClaimedManifest = {
  stateHash: "state-hash",
  tenantId: "tnt_one",
  principalId: "prn_one",
  sessionId: "session-one",
  appCredentialId: "crd_app",
  hookCredentialId: "crd_hook",
  returnOrigin: "https://portal.example",
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

function store(overrides: Partial<ManifestCompletionStore> = {}) {
  const calls: string[] = [];
  const value: ManifestCompletionStore & { calls: string[] } = {
    calls,
    async claim() {
      return { kind: "claimed", value: claim };
    },
    async commit(_claimed, converted) {
      calls.push(`commit:${converted.slug}`);
    },
    async release(_claimed, retryable) {
      calls.push(`release:${retryable}`);
    },
    ...overrides,
  };
  return value;
}

async function convert() {
  return conversion;
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

/** A start() transaction whose selects return: no live setup, the GitHub provider, then `credentials`. */
function startDb(credentials: unknown[], onInsert: () => void) {
  const results = [[], [GITHUB_PROVIDER], credentials];
  const tx = {
    async execute() {},
    select() {
      return { from() { return { where() { return rowsQuery(results.shift() ?? []); } }; } };
    },
    insert() {
      return { async values() { onInsert(); } };
    },
  };
  return {
    query: { principal: { findFirst: activeMember } },
    async transaction(fn: (value: typeof tx) => unknown) {
      return fn(tx);
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
    test(`start returns 403 to a grantless member before reserving ${label}`, async () => {
      let inserted = false;
      const integration = createGithubManifestIntegration({
        db: startDb([...credentials], function markInserted() { inserted = true; }),
        cipher: {} as never,
        getSession: signedInSession,
        authorizeCredential: deny,
        trustedPortalOrigins: [],
        githubApiOrigin: GITHUB_API_ORIGIN,
        publicOrigin: "https://hub.example.com",
      });
      const response = await integration.start(startRequest(), "tnt_one");
      expect(response.status).toBe(403);
      expect(inserted).toBeFalse();
    });
  }

  test("callback returns 403 without exchanging the code when replacement authority is absent", async () => {
    let exchanged = false;
    const pending = {
      stateHash: "unused", tenantId: "tnt_one", principalId: "prn_one", sessionId: "ses_one",
      appCredentialId: "crd_app", hookCredentialId: "crd_hook", providerId: "prv_github",
      returnOrigin: "https://portal.example", replacement: true, status: "pending",
      appSlug: null, expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date(),
    };
    async function exchangeSpy() {
      exchanged = true;
      return Response.json(conversion);
    }
    const integration = createGithubManifestIntegration({
      db: {
        query: { principal: { findFirst: activeMember } },
        select() { return { from() { return { async where() { return [pending]; } }; } }; },
      } as never,
      cipher: {} as never,
      getSession: signedInSession,
      authorizeCredential: deny,
      trustedPortalOrigins: [],
      githubApiOrigin: GITHUB_API_ORIGIN,
      publicOrigin: "https://hub.example.com",
      fetchImpl: Object.assign(exchangeSpy, { preconnect: noPreconnect }),
    });
    const response = await integration.callback(new Request("https://hub.example/api/integrations/github-manifest/callback?state=state&code=code"));
    expect(response.status).toBe(403);
    expect(exchanged).toBeFalse();
  });

  test("allows only the owning principal to restart abandoned pending setup", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const pending = { principalId: "prn_owner", status: "pending", expiresAt: new Date("2026-03-10T13:00:00Z") };
    expect(pendingSetupAction(pending, "prn_owner", false, now)).toBe("owned");
    expect(pendingSetupAction(pending, "prn_owner", true, now)).toBe("replace");
    expect(pendingSetupAction(pending, "prn_attacker", true, now)).toBe("other");
    expect(pendingSetupAction({ ...pending, status: "processing" }, "prn_owner", true, now)).toBe("owned");
    expect(pendingSetupAction({ ...pending, expiresAt: now }, "prn_attacker", true, now)).toBe("expired");
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
      metadata: { webhook: { verify: "standard-webhooks", workflow: "pr-triage" } },
    });
    const metadata = JSON.stringify(prepared.values.map((value) => value.metadata));
    expect(metadata).not.toContain("PRIVATE-KEY-SENTINEL");
    expect(metadata).not.toContain("WEBHOOK-SECRET-SENTINEL");
  });
});

describe("GitHub manifest completion", () => {
  test("binds state to session, principal, and tenant before exchanging", async () => {
    let exchanged = false;
    const result = await completeManifest({
      state: "state", code: "code",
      identity: { sessionId: "other", principalId: "prn_one", tenantId: "tnt_one" },
      store: store({ async claim() { return { kind: "rejected", reason: "identity_mismatch" }; } }),
      async exchange() {
        exchanged = true;
        return conversion;
      },
    });
    expect(result).toEqual({ kind: "rejected", reason: "identity_mismatch" });
    expect(exchanged).toBeFalse();
  });

  for (const reason of ["expired", "completed"] as const) {
    test(`rejects ${reason} state without exchanging`, async () => {
      let exchanged = false;
      const result = await completeManifest({
        state: "state", code: "code", identity: claim,
        store: store({ async claim() { return { kind: "rejected", reason }; } }),
        async exchange() {
          exchanged = true;
          return conversion;
        },
      });
      expect(result).toEqual({ kind: "rejected", reason });
      expect(exchanged).toBeFalse();
    });
  }

  test("only one concurrent callback can claim a pending state", async () => {
    let claimed = false;
    let exchanges = 0;
    const options = {
      state: "state", code: "code", identity: claim,
      store: store({
        async claim() {
          if (claimed) return { kind: "rejected", reason: "processing" };
          claimed = true;
          return { kind: "claimed", value: claim };
        },
      }),
      async exchange() {
        exchanges += 1;
        return conversion;
      },
    };
    const results = await Promise.all([completeManifest(options), completeManifest(options)]);
    expect(results.map((item) => item.kind).sort()).toEqual(["completed", "rejected"]);
    expect(exchanges).toBe(1);
  });

  test("releases state after GitHub errors and never includes query values or secrets in logs/results", async () => {
    const db = store();
    const logs: string[] = [];
    const result = await completeManifest({
      state: "STATE-SENTINEL", code: "CODE-SENTINEL", identity: claim, store: db,
      async exchange(): Promise<never> {
        throw new Error("GitHub unavailable");
      },
      log(event) {
        logs.push(JSON.stringify(event));
      },
    });
    expect(result).toEqual({ kind: "failed", retryable: true });
    expect(db.calls).toContain("release:true");
    const observable = JSON.stringify({ result, logs });
    expect(observable).not.toContain("STATE-SENTINEL");
    expect(observable).not.toContain("CODE-SENTINEL");
    expect(observable).not.toContain("PRIVATE-KEY-SENTINEL");
    expect(observable).not.toContain("WEBHOOK-SECRET-SENTINEL");
  });

  test("a failed credential commit releases the state as non-retryable", async () => {
    const db = store({
      async commit() {
        throw new Error("transaction rolled back");
      },
    });
    const result = await completeManifest({ state: "state", code: "code", identity: claim, store: db, exchange: convert });
    expect(result).toEqual({ kind: "failed", retryable: false });
    expect(db.calls).toContain("release:false");
  });
});
