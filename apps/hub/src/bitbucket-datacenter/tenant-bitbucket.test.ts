import { expect, test } from "bun:test";
import type { DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import type { TriageJob } from "../github/coordinator.js";
import { jobWorkflowsFor, triageWorkflowFor } from "../github/source-workflow.js";
import { checkedBitbucketSpawner, createTenantBitbucket } from "./tenant-bitbucket.js";

const TENANT = { config: { corbitsTriage: { bitbucketDatacenter: { baseUrl: "https://git.example" } } } };

const KNOWN_BITBUCKET_WORKFLOWS = ["pr-triage-bitbucket-datacenter", "pr-code-review-bitbucket-datacenter", "pr-workflow-anthropic-bitbucket-datacenter"];

function job(workflow: string): TriageJob {
  return { tenantId: "tnt_spawn", workflow, repo: "ACME/widgets", number: 1, headSha: "abc", source: "event", payload: {} };
}

test("no Bitbucket worker is spawned once the stored host resolves to an address the token may not reach", async () => {
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
  const workflows = jobWorkflowsFor("bitbucket-datacenter");
  expect(workflows).toEqual(expect.arrayContaining(KNOWN_BITBUCKET_WORKFLOWS));
  for (const workflow of workflows) {
    await expect(spawner.spawn(job(workflow))).rejects.toThrow("host is refused");
  }
  expect(await spawner.spawn(job(triageWorkflowFor("github").id))).toBe("run_worker");
  expect(spawned).toEqual([triageWorkflowFor("github").id]);
});
