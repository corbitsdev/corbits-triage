import { expect, test } from "bun:test";
import type { DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import { createBitbucketIntegration } from "./integration.js";

const MEMBER = { tenantId: "tnt_bitbucket", principalId: "prn_user" };
const BODY = { baseUrl: "http://git.internal:7990", token: "token" };

function unreachable(name: string): never {
  throw new Error(`${name} should not be called`);
}

function integration(address: string, allowlist: readonly string[] = []) {
  return createBitbucketIntegration({
    db: { query: { tenant: { findFirst: () => unreachable("db") } } } as unknown as DB["db"],
    cipher: {} as CredentialCipher,
    async authorize() { return true; },
    stockFetch: () => unreachable("stock"),
    publicOrigin: "https://hub.test",
    fetchImpl: (() => unreachable("fetch")) as unknown as typeof fetch,
    onEnabled() {},
    async onConnectionChanged() {},
    now: () => new Date(),
    log() {},
    egressAllowlist: allowlist,
    async lookup() { return [{ address, family: 4 }]; },
  });
}

test("connect refuses a host that resolves to loopback or a private address before the token is tried", async () => {
  for (const address of ["127.0.0.1", "10.0.0.5"]) {
    const res = await integration(address).connect(BODY, MEMBER, new Request("https://hub.test/connection"));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("allowlisted that host");
  }
});

test("connect does not refuse a listed host that resolves only to a private address", async () => {
  const res = await createBitbucketIntegration({
    db: { query: { tenant: { async findFirst() { return undefined; } } } } as unknown as DB["db"],
    cipher: {} as CredentialCipher,
    async authorize() { return true; },
    stockFetch: () => unreachable("stock"),
    publicOrigin: "https://hub.test",
    fetchImpl: (() => { throw new TypeError("unreachable"); }) as unknown as typeof fetch,
    onEnabled() {},
    async onConnectionChanged() {},
    now: () => new Date(),
    log() {},
    egressAllowlist: ["git.internal"],
    async lookup() { return [{ address: "10.0.0.5", family: 4 }]; },
  }).connect(BODY, MEMBER, new Request("https://hub.test/connection"));
  expect(res.status).not.toBe(400);
});
