import { eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { type } from "arktype";
import { lifecycleDurationMs, LifecycleDuration } from "@intx/types";
import { asRecord } from "@corbits/common";
import { ensureDeployerRole } from "../deployer-role.js";

/** The local part of the system principal that publishes and deploys a workspace's workflows. */
export const TRIAGE_PUBLISHER = "triage-publisher";

/** The longest lifetime Interchange accepts, so a deployment lives until a newer one replaces it. */
const KEEP_DEPLOYED_LIFETIME = "36500d";

function keepsDeployed(lifetime: unknown): boolean {
  const parsed = LifecycleDuration(lifetime);
  return !(parsed instanceof type.errors) && lifecycleDurationMs(parsed) >= lifecycleDurationMs(KEEP_DEPLOYED_LIFETIME);
}

/**
 * Gives the workspace's publisher the Deployer role, whose grants every deployment it starts acts under. Interchange
 * creates a workflow's definition during its first deploy, so a per-definition lifecycle cannot apply to that
 * deployment, and stock takes no lifetime per deployment; the workspace only runs Triage's workflows, so its ceiling keeps
 * each listener until a newer one replaces it.
 */
export async function setUpPublisher(db: DB["db"], tenantId: string, principalId: string, stamp: Date): Promise<void> {
  await db.transaction(async function setUp(tx) {
    const roleId = await ensureDeployerRole(tx, tenantId, stamp);
    await tx.insert(schema.principalRole).values({ principalId, roleId }).onConflictDoNothing();
    const [row] = await tx.select({ config: schema.tenant.config }).from(schema.tenant).where(eq(schema.tenant.id, tenantId)).for("update");
    if (!row) throw new Error(`Workspace ${tenantId} not found.`);
    const config = asRecord(row.config) ?? {};
    const lifecycle = asRecord(config["lifecycle"]) ?? {};
    if (keepsDeployed(lifecycle["maxLifetime"])) return;
    await tx.update(schema.tenant)
      .set({ config: { ...config, lifecycle: { ...lifecycle, maxLifetime: KEEP_DEPLOYED_LIFETIME } }, updatedAt: stamp })
      .where(eq(schema.tenant.id, tenantId));
  });
}
