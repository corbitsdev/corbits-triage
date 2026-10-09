// The hub bridge finds deployments by workflow name, so each workflow is
// redeployed only when its source changed, no live deployment exists, or the
// decision model changed (a deployment resolves its offering when deployed).
import { ApiError, deployWorkflow, listWorkflowDeployments, type Transport, type WorkflowDeployment } from "@intx/hub-client";
import { pushFiles } from "./git-push.ts";
import { requestOrigin } from "./hub-origin.ts";
import { DECISION_MODEL_ALIAS, isLiveDeployment } from "./hub-api.ts";
import { WORKFLOW_PACKAGES, workflowPackageFiles, type WorkflowPackage } from "./workflow-packages.ts";

/** Provider plugin the triage agents infer through (packages/triage-workflows/src/agents.ts). */
const INFERENCE_PLUGIN = "corbits-system-one";
const GIT_TOKEN_TTL_MS = 10 * 60_000;

type ModelInfo = { canonicalName: string; offerings: Array<{ offeringId: string; plugin: string; priority: number }> };
type Asset = { id: string; kind: string; name: string };

export type OfferingSuggestion = { ids: string[]; defaultId: string };

/** The tenant's decision-model offering, or null before one is connected. */
export async function suggestOfferings(transport: Transport, tenantId: string): Promise<OfferingSuggestion | null> {
  const models = await transport.fetch<ModelInfo[]>("GET", `/api/tenants/${encodeURIComponent(tenantId)}/models`);
  const offering = models
    .find((model) => model.canonicalName === DECISION_MODEL_ALIAS)
    ?.offerings.find((o) => o.plugin === INFERENCE_PLUGIN);
  return offering ? { ids: [offering.offeringId], defaultId: offering.offeringId } : null;
}

async function ensureAsset(transport: Transport, tenantId: string, name: string): Promise<Asset> {
  const base = `/api/tenants/${encodeURIComponent(tenantId)}/assets`;
  const assets = await transport.fetch<Asset[]>("GET", `${base}?kind=workflow`);
  return assets.find((asset) => asset.name === name)
    ?? transport.fetch<Asset>("POST", base, { kind: "workflow", name });
}

async function packageFiles(workflow: WorkflowPackage): Promise<Record<string, string>> {
  async function readFile(file: string) {
    const response = await fetch(`/workflows/${workflow.name}/${file}`);
    if (!response.ok) throw new Error(`The portal build is missing the ${workflow.name} workflow (${file}).`);
    return [file, await response.text()] as const;
  }
  return Object.fromEntries(await Promise.all(workflowPackageFiles(workflow).map(readFile)));
}

async function pushWorkflow(transport: Transport, tenantId: string, asset: Asset, workflow: WorkflowPackage) {
  const tid = encodeURIComponent(tenantId);
  const { secret } = await transport.fetch<{ secret: string }>("POST", `/api/tenants/${tid}/git-tokens`, {
    name: `portal-${workflow.name}-${Date.now()}`,
    resource: `asset:${asset.id}`,
    refPattern: "refs/heads/main",
    actions: ["can_read", "can_push"],
    expiresAt: new Date(Date.now() + GIT_TOKEN_TTL_MS).toISOString(),
  });
  return pushFiles({
    url: new URL(`${requestOrigin()}/api/tenants/${tid}/assets/workflow/${encodeURIComponent(asset.name)}.git`, window.location.href).href,
    token: secret,
    files: await packageFiles(workflow),
    message: `${workflow.name} workflow`,
  });
}

/** The longest lifetime Interchange accepts, so a deployment lives until a newer one replaces it. */
const KEEP_DEPLOYED_LIFETIME = "36500d";

/**
 * Interchange creates a workflow's definition during its first deploy, so a
 * per-definition lifecycle cannot apply to that deployment. The tenant only
 * runs triage workflows, so its ceiling keeps every triage listener
 * (pr-triage and pr-triage-historical) deployed until a newer one replaces it.
 */
async function ensureKeepDeployedLifetime(transport: Transport, tenantId: string): Promise<void> {
  const path = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const { config } = await transport.fetch<{ config?: { lifecycle?: { maxLifetime?: string } } }>("GET", path);
  if (config?.lifecycle?.maxLifetime === KEEP_DEPLOYED_LIFETIME) return;
  await transport.fetch("PATCH", path, { config: { lifecycle: { ...config?.lifecycle, maxLifetime: KEEP_DEPLOYED_LIFETIME } } });
}

/** A deployment's id is its anchor run's id; 409 means it already stopped. */
async function cancelDeployment(transport: Transport, tenantId: string, deploymentId: string): Promise<void> {
  try {
    await transport.fetch("DELETE", `/api/tenants/${encodeURIComponent(tenantId)}/workflows/runs/${encodeURIComponent(deploymentId)}`);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error;
  }
}

function newestFirst(a: WorkflowDeployment, b: WorkflowDeployment): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/** Cancels every live deployment of the asset except the newest. */
async function cancelSuperseded(transport: Transport, tenantId: string, assetId: string): Promise<void> {
  const deployments = await listWorkflowDeployments(transport, tenantId);
  const ofAsset = deployments.filter((d) => d.definitionAssetId === assetId).sort(newestFirst);
  for (const old of ofAsset.slice(1)) {
    if (isLiveDeployment(old.status)) await cancelDeployment(transport, tenantId, old.id);
  }
}

/**
 * The hub replaces a busy pr-triage deployment with a copy and releases the
 * old one itself, so pr-triage's superseded deployments are cancelled here
 * only right after a deploy; other workflows' are cancelled on every converge,
 * which retries a failed cancel.
 */
export function cancelsSuperseded(workflow: string, deployed: boolean): boolean {
  return deployed || workflow !== "pr-triage";
}

export async function ensureWorkflows(transport: Transport, tenantId: string, offerings: OfferingSuggestion, redeploy: boolean): Promise<string[]> {
  const deployments = await listWorkflowDeployments(transport, tenantId);
  await ensureKeepDeployedLifetime(transport, tenantId);
  const deployed: string[] = [];
  for (const workflow of WORKFLOW_PACKAGES) {
    const asset = await ensureAsset(transport, tenantId, workflow.name);
    const ofAsset = deployments.filter((d) => d.definitionAssetId === asset.id).sort(newestFirst);
    const { commitSha, changed } = await pushWorkflow(transport, tenantId, asset, workflow);
    const live = ofAsset.some((d) => isLiveDeployment(d.status));
    const deploy = changed || redeploy || !live;
    if (deploy) {
      await deployWorkflow(transport, tenantId, {
        source: { kind: "asset", assetId: asset.id, package: { format: "source", commitSha, packageName: workflow.packageName } },
        entry: workflow.entry,
        sourceOfferingIds: offerings.ids,
        defaultSourceOfferingId: offerings.defaultId,
      });
      deployed.push(workflow.name);
    }
    if (cancelsSuperseded(workflow.name, deploy)) await cancelSuperseded(transport, tenantId, asset.id);
  }
  return deployed;
}
