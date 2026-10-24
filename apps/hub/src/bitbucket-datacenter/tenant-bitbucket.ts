// A tenant's Bitbucket Data Center instance, read with the token it resolves (its own or a parent's) at the instance
// that token's workspace connected, for hub-side work.
import type { DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import type { BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { tenantConfigOf } from "../github/bridge.js";
import { activeCredential, credentialSecret } from "../github/portal-credential.js";
import { triageNs } from "../github/tenant-config.js";
import type { TriageJob, WorkerSpawner } from "../github/coordinator.js";
import { jobWorkflowsFor } from "../github/source-workflow.js";
import { bitbucketFetch, lookupAddresses, resolveInstance, type AddressLookup } from "./client.js";
import { bitbucketConnection, TOKEN_CREDENTIAL } from "./records.js";

type TenantBitbucketDeps = {
  db: DB["db"];
  cipher: CredentialCipher;
  fetchImpl: typeof fetch;
  lookup?: AddressLookup;
  egressAllowlist?: readonly string[];
};

export type TenantBitbucket = (tenantId: string) => Promise<BitbucketFetch | undefined>;

/** Undefined when the tenant resolves no active token, the token's workspace has no connected instance, or its host is refused. */
export function createTenantBitbucket(deps: TenantBitbucketDeps): TenantBitbucket {
  const lookup = deps.lookup ?? lookupAddresses;

  return async function tenantBitbucket(tenantId) {
    const credential = await activeCredential(deps.db, tenantId, TOKEN_CREDENTIAL);
    if (!credential) return undefined;
    const connection = bitbucketConnection(triageNs(await tenantConfigOf(deps, credential.tenantId)));
    if (!connection) return undefined;
    const checked = await resolveInstance(connection.baseUrl, lookup, deps.egressAllowlist);
    if (checked === undefined) return undefined;
    return bitbucketFetch(deps.fetchImpl, checked, await credentialSecret(deps.cipher, credential));
  };
}

const BITBUCKET_WORKFLOWS = new Set(jobWorkflowsFor("bitbucket-datacenter"));

/** A Bitbucket run sends the token to the stored instance, so its worker is spawned only while that host passes the check. */
export function checkedBitbucketSpawner(spawner: WorkerSpawner, tenantBitbucket: TenantBitbucket): WorkerSpawner {
  async function spawn(job: TriageJob): Promise<string> {
    if (BITBUCKET_WORKFLOWS.has(job.workflow) && (await tenantBitbucket(job.tenantId)) === undefined) {
      throw new Error("Bitbucket is not connected, has no active token, or its host is refused");
    }
    return spawner.spawn(job);
  }
  return { ...spawner, spawn };
}
