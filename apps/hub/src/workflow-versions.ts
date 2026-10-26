// No stock route exposes a deployment's pin, so the portal reads the versions
// and source it runs from each live deployment's frozen bundle here.
import type { DB, WorkflowRunLaunchSpecStore } from "@intx/db";
import type { FrozenApprovalBundle } from "@intx/types/sidecar";
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

function sourceOf(bundle: FrozenApprovalBundle): DeployedVersions["deployments"][number]["source"] {
  if (bundle.source.kind !== "asset" || bundle.source.package.format !== "source") return null;
  return { assetId: bundle.source.assetId, commitSha: bundle.source.package.commitSha };
}

export function createWorkflowVersions(deps: WorkflowVersionsDeps) {
  return async function handle({ tenantId }: Member): Promise<Response> {
    const deployments: DeployedVersions["deployments"] = [];
    for (const kind of ["listener", "worker"] as const) {
      for (const live of await resolveLiveDeployments(deps.db, tenantId, undefined, kind)) {
        const spec = await deps.launchSpecs.get(live.runId);
        const versions = spec ? closureVersions(spec.frozenApprovalBundle) : null;
        deployments.push({
          id: live.runId,
          workflow: live.workflow,
          createdAt: live.createdAt.toISOString(),
          cancelling: live.cancelling,
          live: await deps.up(live.runId),
          worker: kind === "worker",
          package: versions?.workflow ?? null,
          tools: versions?.tools ?? [],
          source: spec ? sourceOf(spec.frozenApprovalBundle) : null,
        });
      }
    }
    return Response.json({ deployments } satisfies DeployedVersions);
  };
}
