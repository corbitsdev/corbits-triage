// The stock deploy route takes its definition asset from the source and
// refuses a package-registry source; delete this route once upstream PR 195 lands.
import { and, eq } from "drizzle-orm";
import { type, type Traversal } from "arktype";
import { schema, TenantConfigInvalidError, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { WorkflowProvisioningError, type WorkflowAllocationService } from "@intx/hub-sessions";
import { parsePin } from "@intx/tool-packaging";
import type { WorkflowDeploymentResponse } from "@intx/types";
import { WorkflowDefinitionInvalidError } from "@intx/workflow-deploy";
import { failure } from "./github/portal-credential.js";
import { connectedSources, entrySource } from "./github/source-workflow.js";
import type { Member } from "./integrations/app.js";

export const WORKFLOW_DEPLOY_PATH = "/api/integrations/workflow-deploy";

const OfferingIds = type("string > 0")
  .array()
  .atLeastLength(1)
  .narrow((ids, ctx) => new Set(ids).size === ids.length || ctx.mustBe("a list of unique catalog offering ids"));

function validPin(pin: string, ctx: Traversal): boolean {
  try {
    parsePin(pin);
    return true;
  } catch {
    return ctx.mustBe("a package pin like name@version");
  }
}

export const DeployBody = type({
  registryAssetId: "string > 0",
  definitionAssetId: "string > 0",
  pin: type("string").narrow(validPin),
  entry: "string > 0",
  sourceOfferingIds: OfferingIds,
  defaultSourceOfferingId: "string > 0",
});

export type WorkflowDeployDeps = {
  db: DB["db"];
  allocation: Pick<WorkflowAllocationService, "prepareProvisionedDeployment">;
  /** After a deployment: the hub releases what the new one supersedes, such as the pre-host `pr-triage` deployment, and keeps the host deployments to the connected hosts. */
  onDeployed: (tenantId: string) => Promise<void>;
};

export function createWorkflowDeploy(deps: WorkflowDeployDeps) {
  function tenantAsset(tenantId: string, assetId: string, kind: "workflow" | "package-registry") {
    return deps.db.query.asset.findFirst({
      where: and(eq(schema.asset.id, assetId), eq(schema.asset.tenantId, tenantId), eq(schema.asset.kind, kind)),
      columns: { id: true },
    });
  }

  return async function handle(body: typeof DeployBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { domain: true } });
    if (!tenant) return failure(404, "not_found", "Workspace not found");
    if (!(await tenantAsset(tenantId, body.definitionAssetId, "workflow"))) return failure(404, "not_found", "Workflow asset not found");
    if (!(await tenantAsset(tenantId, body.registryAssetId, "package-registry"))) return failure(404, "not_found", "Package registry asset not found");
    // A host's package binds that host's credential, which an unresolved binding would fail: it deploys once the host is connected.
    const needs = entrySource(body.entry);
    if (needs !== undefined && !(await connectedSources(deps.db, tenantId)).includes(needs)) {
      return failure(409, "source_not_connected", `Connect ${needs} before deploying ${body.entry.slice(2, -4)}.`);
    }

    let prepared;
    try {
      prepared = await deps.allocation.prepareProvisionedDeployment({
        tenantId,
        anchorRunId: generateId("workflowRun"),
        deploymentDomain: tenant.domain,
        source: { kind: "asset", assetId: body.registryAssetId, package: { format: "tarball" } },
        entry: body.entry,
        pin: body.pin,
        definitionAssetId: body.definitionAssetId,
        sessionId: generateId("session"),
        sourceAuthorityPrincipalId: principalId,
        sourceOfferingIds: body.sourceOfferingIds,
        defaultSourceOfferingId: body.defaultSourceOfferingId,
        deployContent: { systemPrompt: "" },
      });
    } catch (err) {
      if (err instanceof WorkflowDefinitionInvalidError) return failure(409, "invalid_workflow", err.message);
      if (err instanceof TenantConfigInvalidError) return failure(409, "invalid_tenant_config", "The tenant or an ancestor has invalid configuration");
      if (err instanceof WorkflowProvisioningError) return failure(409, err.code, err.message);
      return failure(502, "sidecar_unavailable", err instanceof Error ? err.message : "Failed to deploy workflow");
    }

    const run = await deps.db.query.workflowRun.findFirst({
      where: eq(schema.workflowRun.id, prepared.anchorRunId),
      columns: { createdAt: true },
    });
    if (!run) return failure(500, "anchor_run_missing", `anchor workflow_run ${prepared.anchorRunId} missing after deployment preparation`);
    const deployment: WorkflowDeploymentResponse = {
      id: prepared.anchorRunId,
      tenantId,
      definitionAssetId: body.definitionAssetId,
      status: prepared.status,
      createdAt: run.createdAt.toISOString(),
    };
    await deps.onDeployed(tenantId);
    return Response.json(deployment, { status: 201 });
  };
}
