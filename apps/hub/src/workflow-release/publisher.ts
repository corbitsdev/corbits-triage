import { ensureDeployerRole } from "../deployer-role.js";
import { assignRole, ASSIGNS_ROLE, keepDeploymentsAlive, managesTenant } from "../system-writes/tenant.js";
import type { SystemWrites } from "../system-writes/writer.js";

/** The local part of the system principal that publishes and deploys a workspace's workflows. */
export const TRIAGE_PUBLISHER = "triage-publisher";

/**
 * Gives the workspace's publisher the Deployer role, whose grants every deployment it starts acts under. Interchange
 * creates a workflow's definition during its first deploy, so a per-definition lifecycle cannot apply to that
 * deployment, and stock takes no lifetime per deployment; the workspace only runs Triage's workflows, so its ceiling keeps
 * each listener until a newer one replaces it.
 */
export async function setUpPublisher(writes: SystemWrites, tenantId: string, principalId: string, stamp: Date): Promise<void> {
  await writes.transaction(tenantId, [ASSIGNS_ROLE, managesTenant(tenantId)], async function setUp(w) {
    const roleId = await ensureDeployerRole(w.tx, tenantId, stamp);
    await assignRole(w, principalId, roleId);
    await keepDeploymentsAlive(w, stamp);
  });
}
