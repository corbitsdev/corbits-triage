// A tenant's Bitbucket Data Center instance, read as its stored token, for hub-side work.
import type { DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import type { BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { tenantConfigOf } from "../github/bridge.js";
import { activeCredential } from "../github/portal-credential.js";
import { triageNs } from "../github/tenant-config.js";
import { bitbucketFetch, lookupAddresses, resolveInstanceBaseUrl, type AddressLookup } from "./client.js";
import { bitbucketConnection, TOKEN_CREDENTIAL } from "./records.js";

type TenantBitbucketDeps = {
  db: DB["db"];
  cipher: CredentialCipher;
  fetchImpl: typeof fetch;
  lookup?: AddressLookup;
  egressAllowlist?: readonly string[];
};

export type TenantBitbucket = (tenantId: string) => Promise<BitbucketFetch | undefined>;

/** Undefined when the tenant has no connected instance or no active token. */
export function createTenantBitbucket(deps: TenantBitbucketDeps): TenantBitbucket {
  const egressAllowlist = deps.egressAllowlist ?? [];

  function hostLookup(hostname: string): Promise<readonly { address: string; family: number }[]> {
    return (deps.lookup ?? lookupAddresses)(hostname);
  }

  return async function tenantBitbucket(tenantId) {
    const connection = bitbucketConnection(triageNs(await tenantConfigOf(deps, tenantId)), egressAllowlist);
    if (!connection) return undefined;
    const baseUrl = await resolveInstanceBaseUrl(connection.baseUrl, hostLookup, egressAllowlist);
    if (baseUrl === undefined) return undefined;
    const credential = await activeCredential(deps.db, tenantId, TOKEN_CREDENTIAL);
    if (!credential) return undefined;
    const token = await deps.cipher.decrypt(credential.secret, credentialAad(credential.id, "secret"));
    return bitbucketFetch(deps.fetchImpl, baseUrl, token);
  };
}
