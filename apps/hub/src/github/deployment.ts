import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { schema, type DB } from "@intx/db";

export class NoLiveDeploymentError extends Error {
  constructor(readonly workflow: string) {
    super(`no live ${workflow} deployment`);
  }
}

/** Matches how the hub lists deployments: a deployment is its anchor run. */
export async function resolveLiveDeployment(
  db: DB["db"],
  tenantId: string,
  definitionName: string,
): Promise<{ runId: string; address: string } | null> {
  const { workflowRun, workflowDefinition, tenant, liveWorkflowRunStatuses } = schema;
  const [row] = await db
    .select({ runId: workflowRun.id, domain: tenant.domain })
    .from(workflowRun)
    .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
    .innerJoin(tenant, eq(workflowRun.tenantId, tenant.id))
    .where(and(
      eq(workflowRun.tenantId, tenantId),
      eq(workflowDefinition.name, definitionName),
      isNotNull(workflowRun.anchorRunId),
      eq(workflowRun.id, workflowRun.anchorRunId),
      inArray(workflowRun.status, [...liveWorkflowRunStatuses]),
    ))
    .orderBy(desc(workflowRun.createdAt))
    .limit(1);
  return row ? { runId: row.runId, address: `${row.runId}@${row.domain}` } : null;
}
