import { expect, test } from "bun:test";
import type { DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import type { TriageJob } from "../github/coordinator.js";
import { triageWorkflowFor } from "../github/source-workflow.js";
import { checkedBitbucketSpawner, createTenantBitbucket } from "./tenant-bitbucket.js";

const TENANT = { config: { corbitsTriage: { bitbucketDatacenter: { baseUrl: "https://git.example" } } } };

function job(source: "github" | "bitbucket-datacenter"): TriageJob {
  return { tenantId: "tnt_spawn", workflow: triageWorkflowFor(source).id, repo: "ACME/widgets", number: 1, headSha: "abc", source: "event", payload: {} };
}

test("a Bitbucket worker is not spawned once the stored host resolves to an address the token may not reach", async () => {
  const tenantBitbucket = createTenantBitbucket({
    db: {
      query: {
        tenant: { async findFirst() { return TENANT; } },
        credential: { async findFirst() { return { id: "crd_bb", tenantId: "tnt_spawn", status: "active", principalId: null }; } },
      },
    } as unknown as DB["db"],
    cipher: {} as CredentialCipher,
    fetchImpl: fetch,
    async lookup() { return [{ address: "169.254.169.254", family: 4 }]; },
  });
  const spawned: string[] = [];
  const spawner = checkedBitbucketSpawner({
    async spawn(next) { spawned.push(next.workflow); return "run_worker"; },
    async ended() {},
    async release() {},
  }, tenantBitbucket);
  await expect(spawner.spawn(job("bitbucket-datacenter"))).rejects.toThrow("host is refused");
  expect(await spawner.spawn(job("github"))).toBe("run_worker");
  expect(spawned).toEqual([triageWorkflowFor("github").id]);
});
