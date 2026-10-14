// A tenant's Bitbucket Data Center instance, read as its stored token, for hub-side work.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import type { BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { triageNs } from "../github/tenant-config.js";
import { bitbucketFetch } from "./client.js";
import { bitbucketConnection, TOKEN_CREDENTIAL } from "./records.js";

export type TenantBitbucketDeps = { db: DB["db"]; cipher: CredentialCipher; fetchImpl: typeof fetch };

export type TenantBitbucket = (tenantId: string) => Promise<BitbucketFetch | undefined>;

/** Undefined when the tenant has no connected instance or no active token. */
export function createTenantBitbucket(deps: TenantBitbucketDeps): TenantBitbucket {
  return async function tenantBitbucket(tenantId) {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    const connection = bitbucketConnection(triageNs(tenant?.config));
    if (!connection) return undefined;
    const credential = await deps.db.query.credential.findFirst({
      where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.name, TOKEN_CREDENTIAL), eq(schema.credential.status, "active")),
    });
    if (!credential) return undefined;
    const token = await deps.cipher.decrypt(credential.secret, credentialAad(credential.id, "secret"));
    return bitbucketFetch(deps.fetchImpl, connection.baseUrl, token);
  };
}
