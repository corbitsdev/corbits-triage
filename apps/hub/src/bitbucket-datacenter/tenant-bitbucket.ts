// A tenant's Bitbucket Data Center instance, read as its stored token, for hub-side work.
import type { DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import type { BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { tenantConfigOf } from "../github/bridge.js";
import { activeCredential } from "../github/portal-credential.js";
import { triageNs } from "../github/tenant-config.js";
import type { TriageJob, WorkerSpawner } from "../github/coordinator.js";
import { codeReviewWorkflowFor, triageWorkflowFor } from "../github/source-workflow.js";
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

/** Undefined when the tenant has no connected instance, its host is refused, or it has no active token. */
export function createTenantBitbucket(deps: TenantBitbucketDeps): TenantBitbucket {
  const lookup = deps.lookup ?? lookupAddresses;

  return async function tenantBitbucket(tenantId) {
    const connection = bitbucketConnection(triageNs(await tenantConfigOf(deps, tenantId)));
    if (!connection) return undefined;
    const checked = await resolveInstance(connection.baseUrl, lookup, deps.egressAllowlist);
    if (checked === undefined) return undefined;
    const credential = await activeCredential(deps.db, tenantId, TOKEN_CREDENTIAL);
    if (!credential) return undefined;
    const token = await deps.cipher.decrypt(credential.secret, credentialAad(credential.id, "secret"));
    return bitbucketFetch(deps.fetchImpl, checked, token);
  };
}

const BITBUCKET_WORKFLOWS = new Set([triageWorkflowFor("bitbucket-datacenter").id, codeReviewWorkflowFor("bitbucket-datacenter").id]);

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
