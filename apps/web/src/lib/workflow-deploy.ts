// The hub bridge finds deployments by workflow name, so each workflow is
// redeployed only when its current deployment runs another version than this
// build's, none exists, or the decision model changed (a deployment resolves
// its offering when deployed).
import { ApiError, listWorkflowDeployments, type Transport, type WorkflowDeployment } from "@intx/hub-client";
import { requestOrigin } from "./hub-origin.ts";
import { currentDeployment, DECISION_MODEL_ALIAS, isLiveDeployment, listDeployedWorkflows } from "./hub-api.ts";
import { WORKFLOW_PACKAGES, type PackageIndexEntry } from "./workflow-packages.ts";

/** Provider plugin the triage agents infer through (packages/triage-workflows/src/agents.ts). */
const INFERENCE_PLUGIN = "corbits-system-one";
/** The tenant's package registry the tool and workflow tarballs are published to. */
const REGISTRY_NAME = "corbits";

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

async function ensureAsset(transport: Transport, tenantId: string, kind: "workflow" | "package-registry", name: string): Promise<Asset> {
  const base = `/api/tenants/${encodeURIComponent(tenantId)}/assets`;
  const assets = await transport.fetch<Asset[]>("GET", `${base}?kind=${kind}`);
  return assets.find((asset) => asset.name === name)
    ?? transport.fetch<Asset>("POST", base, { kind, name });
}

/** Reads a file the portal build wrote to `public/packages`. */
async function portalPackage(fetchRaw: typeof fetch, file: string): Promise<Response> {
  const response = await fetchRaw(`/packages/${file}`);
  if (!response.ok) throw new Error(`The portal build is missing ${file}.`);
  return response;
}

async function putTarball(fetchRaw: typeof fetch, tenantId: string, registryId: string, entry: PackageIndexEntry, bytes: ArrayBuffer): Promise<void> {
  const path = `/api/tenants/${encodeURIComponent(tenantId)}/assets/${encodeURIComponent(registryId)}/tarballs/${encodeURIComponent(entry.filename)}`;
  const response = await fetchRaw(`${requestOrigin()}${path}`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (response.ok) return;
  let detail: { error?: { code?: string; message?: string } } = {};
  try { detail = await response.json() as typeof detail; } catch { /* generic error below */ }
  throw new ApiError(response.status, detail.error?.code ?? "unknown", detail.error?.message ?? `HTTP ${response.status}`);
}

/**
 * Publishes each tarball the registry lacks, in index order so the tool lands
 * before the workflows that depend on it. A version is never overwritten.
 */
async function publishPackages(
  transport: Transport,
  fetchRaw: typeof fetch,
  tenantId: string,
  registryId: string,
  index: PackageIndexEntry[],
): Promise<void> {
  const listed = await transport.fetch<Array<{ filename: string; integrity: string }>>(
    "GET",
    `/api/tenants/${encodeURIComponent(tenantId)}/assets/${encodeURIComponent(registryId)}/tarballs`,
  );
  const missing: PackageIndexEntry[] = [];
  for (const entry of index) {
    const existing = listed.find((tarball) => tarball.filename === entry.filename);
    if (!existing) missing.push(entry);
    else if (existing.integrity !== entry.integrity) {
      throw new Error(`${entry.name}@${entry.version} is already published with different contents. Bump its version.`);
    }
  }
  for (const entry of missing) {
    await putTarball(fetchRaw, tenantId, registryId, entry, await (await portalPackage(fetchRaw, entry.filename)).arrayBuffer());
  }
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

export async function ensureWorkflows(
  transport: Transport,
  tenantId: string,
  offerings: OfferingSuggestion,
  redeploy: boolean,
  fetchRaw: typeof fetch = fetch,
): Promise<string[]> {
  const deployments = await listDeployedWorkflows(transport, tenantId);
  await ensureKeepDeployedLifetime(transport, tenantId);
  const registry = await ensureAsset(transport, tenantId, "package-registry", REGISTRY_NAME);
  const index = await (await portalPackage(fetchRaw, "index.json")).json() as PackageIndexEntry[];
  await publishPackages(transport, fetchRaw, tenantId, registry.id, index);
  const deployed: string[] = [];
  for (const workflow of WORKFLOW_PACKAGES) {
    const pkg = index.find((entry) => entry.name === workflow.packageName);
    if (!pkg) throw new Error(`The portal build is missing the ${workflow.name} workflow.`);
    // The deploy route needs a workflow asset to name the definition; the code comes from the registry.
    const asset = await ensureAsset(transport, tenantId, "workflow", workflow.name);
    const current = currentDeployment(deployments, workflow.name)?.package;
    const deploy = redeploy || current?.name !== pkg.name || current.version !== pkg.version;
    if (deploy) {
      await transport.fetch<WorkflowDeployment>("POST", `/api/integrations/workflow-deploy/${encodeURIComponent(tenantId)}`, {
        registryAssetId: registry.id,
        definitionAssetId: asset.id,
        pin: `${pkg.name}@${pkg.version}`,
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
