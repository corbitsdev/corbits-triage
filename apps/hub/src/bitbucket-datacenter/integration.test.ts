import { expect, test } from "bun:test";
import type { DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import { createBitbucketIntegration } from "./integration.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const MEMBER = { tenantId: "tnt_bitbucket", principalId: "prn_user" };
const CONNECTED = { config: { corbitsTriage: { bitbucketDatacenter: { baseUrl: "http://git.internal:7990", user: "triage" } } } };

function unreachable(name: string): never {
  throw new Error(`${name} should not be called`);
}

function integration(address: string) {
  return createBitbucketIntegration({
    db: {
      query: {
        tenant: { async findFirst() { return CONNECTED; } },
        credential: { async findFirst() { return { id: "crd_bb", tenantId: MEMBER.tenantId, status: "active", principalId: null }; } },
      },
    } as unknown as DB["db"],
    cipher: {} as CredentialCipher,
    onKeyMoved: noKeyPush,
    async authorize() { return true; },
    stockFetch: () => unreachable("stock"),
    publicOrigin: "https://hub.test",
    fetchImpl: (() => unreachable("fetch")) as unknown as typeof fetch,
    onEnabled() {},
    async onConnectionChanged() {},
    onCredentialsReplaced() {},
    now: () => new Date(),
    log() {},
    egressAllowlist: [],
    async lookup() { return [{ address, family: 4 }]; },
  });
}

test("a stored host that now resolves to a private address is refused when the token would be sent, and still shown", async () => {
  const refused = integration("10.0.0.5");
  const res = await refused.repositories(MEMBER);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bitbucket_datacenter_host_refused");
  expect(await (await refused.connection(MEMBER)).json()).toEqual({ baseUrl: "http://git.internal:7990", hookUrl: "https://hub.test/api/hooks/bitbucket-datacenter/tnt_bitbucket" });
});
