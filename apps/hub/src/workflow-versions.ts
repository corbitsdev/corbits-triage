// No stock route exposes a deployment's pin, so the portal reads the versions
// it runs from each live deployment's frozen closure here.
import type { DB, WorkflowRunLaunchSpecStore } from "@intx/db";
import type { DeployedVersions } from "@corbits/triage-contracts";
import { closureVersions, resolveLiveDeployments } from "./github/deployment.js";
import type { Member } from "./integrations/app.js";

export const WORKFLOW_VERSIONS_PATH = "/api/integrations/workflow-versions";

export type WorkflowVersionsDeps = {
  db: DB["db"];
  launchSpecs: Pick<WorkflowRunLaunchSpecStore, "get">;
  /** Whether the deployment is up as the hub counts a listener or a manager. */
  up: (anchorRunId: string) => Promise<boolean>;
};

export function createWorkflowVersions(deps: WorkflowVersionsDeps) {
  async function versionsOf(anchorRunId: string) {
    const spec = await deps.launchSpecs.get(anchorRunId);
    return spec ? closureVersions(spec.frozenApprovalBundle) : null;
  }

  return async function handle({ tenantId }: Member): Promise<Response> {
    const deployments: DeployedVersions["deployments"] = [];
    for (const kind of ["listener", "worker"] as const) {
      for (const live of await resolveLiveDeployments(deps.db, tenantId, undefined, kind)) {
        const versions = await versionsOf(live.runId);
        deployments.push({
          id: live.runId,
          workflow: live.workflow,
          createdAt: live.createdAt.toISOString(),
          cancelling: live.cancelling,
          live: await deps.up(live.runId),
          worker: kind === "worker",
          package: versions?.workflow ?? null,
          tools: versions?.tools ?? [],
        });
      }
    }
    return Response.json({ deployments } satisfies DeployedVersions);
  };
}
