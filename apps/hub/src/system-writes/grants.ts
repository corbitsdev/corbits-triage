import { allow } from "../github/admin-github-grant.js";
import { CREATES_GRANT } from "./tenant.js";
import { check, type WriteTx } from "./writer.js";

/** Grants a principal directly, as stock grants an asset's creator; once, however often it is asked. */
export async function allowCreator(w: WriteTx, principalId: string, resource: string, action: string, stamp: Date): Promise<void> {
  check(w, CREATES_GRANT);
  await allow(w.tx, w.tenantId, { roleId: null, principalId, origin: "creator" }, resource, action, stamp);
}
