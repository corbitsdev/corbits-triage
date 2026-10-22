import { expect, test } from "bun:test";
import type { DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import { createBitbucketIntegration } from "./integration.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const MEMBER = { tenantId: "tnt_bitbucket", principalId: "prn_user" };
const BODY = { baseUrl: "http://git.internal:7990", token: "token" };
const CONNECTED = { config: { corbitsTriage: { bitbucketDatacenter: { baseUrl: "http://git.internal:7990", user: "triage" } } } };

function unreachable(name: string): never {
  throw new Error(`${name} should not be called`);
}

function integration(address: string, options: { allowlist?: readonly string[]; tenant?: unknown; fetched?: string[] } = {}) {
  return createBitbucketIntegration({
    db: {
      query: {
        tenant: { async findFirst() { return options.tenant; } },
        credential: { async findFirst() { return { id: "crd_bb", tenantId: MEMBER.tenantId, status: "active", principalId: null }; } },
      },
    } as unknown as DB["db"],
    cipher: {} as CredentialCipher,
    onKeyMoved: noKeyPush,
    async authorize() { return true; },
    stockFetch: () => unreachable("stock"),
    publicOrigin: "https://hub.test",
    fetchImpl: async function fetched(input: string | URL | Request) {
      if (!options.fetched) unreachable("fetch");
      options.fetched.push(String(input));
      throw new TypeError("unreachable");
    } as unknown as typeof fetch,
    onEnabled() {},
    async onConnectionChanged() {},
    now: () => new Date(),
    log() {},
    egressAllowlist: options.allowlist ?? [],
    async lookup() { return [{ address, family: 4 }]; },
  });
}

test("connect refuses a host that resolves to loopback or a private address before the token is tried", async () => {
  for (const address of ["127.0.0.1", "10.0.0.5"]) {
    const res = await integration(address).connect(BODY, MEMBER, new Request("https://hub.test/connection"));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("allowlist it");
  }
});

test("connect tries the token at the checked address of a listed host that resolves only to a private address", async () => {
  const fetched: string[] = [];
  await integration("10.0.0.5", { allowlist: ["git.internal"], fetched }).connect(BODY, MEMBER, new Request("https://hub.test/connection"));
  expect(fetched).toEqual(["http://10.0.0.5:7990/rest/api/1.0/application-properties"]);
});

test("a stored host that now resolves to a private address is refused when the token would be sent, and still shown", async () => {
  const refused = integration("10.0.0.5", { tenant: CONNECTED });
  const res = await refused.repositories(MEMBER);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bitbucket_datacenter_host_refused");
  expect(await (await refused.connection(MEMBER)).json()).toEqual({ baseUrl: "http://git.internal:7990", hookUrl: "https://hub.test/api/hooks/bitbucket-datacenter/tnt_bitbucket" });
});
