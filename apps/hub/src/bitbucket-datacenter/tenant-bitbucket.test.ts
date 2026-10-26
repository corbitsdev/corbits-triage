import { expect, test } from "bun:test";
import type { DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import { checkedBitbucketDelivery, createTenantBitbucket } from "./tenant-bitbucket.js";

const TENANT = { config: { corbitsTriage: { bitbucketDatacenter: { baseUrl: "https://git.example" } } } };

test("no Bitbucket mail reaches the listener once the stored host resolves to an address the token may not reach", async () => {
  const tenantBitbucket = createTenantBitbucket({
    db: {
      query: {
        tenant: { async findFirst() { return TENANT; } },
        credential: { async findFirst() { return { id: "crd_bb", tenantId: "tnt_mail", status: "active", principalId: null }; } },
      },
    } as unknown as DB["db"],
    cipher: {} as CredentialCipher,
    fetchImpl: fetch,
    async lookup() { return [{ address: "169.254.169.254", family: 4 }]; },
  });
  const delivered: unknown[] = [];
  const deliver = checkedBitbucketDelivery(async function record(_tenantId, _address, payload) {
    delivered.push(payload);
  }, tenantBitbucket);
  await expect(deliver("tnt_mail", "run_listener@tenant.example", { repoSource: "bitbucket-datacenter", repo: "ACME/widgets" })).rejects.toThrow("host is refused");
  await deliver("tnt_mail", "run_listener@tenant.example", { repoSource: "github", repo: "acme/widgets" });
  expect(delivered).toEqual([{ repoSource: "github", repo: "acme/widgets" }]);
});
