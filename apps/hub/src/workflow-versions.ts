// No stock route exposes a deployment's pin, so the portal reads the versions
// it runs from each live deployment's frozen closure here.
import { type } from "arktype";
import type { DB, WorkflowRunLaunchSpecStore } from "@intx/db";
import { closureVersions, resolveLiveDeployments } from "./github/deployment.js";
import type { Member } from "./integrations/app.js";

export const WORKFLOW_VERSIONS_PATH = "/api/integrations/workflow-versions";

const PackageVersion = type({ name: "string", version: "string" });

export const DeployedVersions = type({
  deployments: type({
    id: "string",
    workflow: "string",
    createdAt: "string",
    cancelling: "boolean",
    package: PackageVersion.or("null"),
    tools: PackageVersion.array(),
  }).array(),
});
export type DeployedVersions = typeof DeployedVersions.infer;

export type WorkflowVersionsDeps = {
  db: DB["db"];
  launchSpecs: Pick<WorkflowRunLaunchSpecStore, "get">;
};

export function createWorkflowVersions(deps: WorkflowVersionsDeps) {
  async function versionsOf(anchorRunId: string) {
    const spec = await deps.launchSpecs.get(anchorRunId);
    return spec ? closureVersions(spec.frozenApprovalBundle) : null;
  }

  return async function handle({ tenantId }: Member): Promise<Response> {
    const deployments: DeployedVersions["deployments"] = [];
    for (const live of await resolveLiveDeployments(deps.db, tenantId)) {
      const versions = await versionsOf(live.runId);
      deployments.push({
        id: live.runId,
        workflow: live.workflow,
        createdAt: live.createdAt.toISOString(),
        cancelling: live.cancelling,
        package: versions?.workflow ?? null,
        tools: versions?.tools ?? [],
      });
    }
    return Response.json({ deployments } satisfies DeployedVersions);
  };
}
