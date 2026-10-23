// The hub bridge finds deployments by workflow name, so each workflow is
// redeployed only when its current deployment runs another version than this
// build's, none exists, or its model's key changed (a deployment resolves
// its offerings when deployed).
import { ApiError, listWorkflowDeployments, type Transport, type WorkflowDeployment } from "@intx/hub-client";
import { requestOrigin } from "./hub-origin.ts";
import { currentDeployment, isLiveDeployment, listDeployedWorkflows, type DeployedWorkflow } from "./hub-api.ts";
import { offeringsFor } from "./model-catalog.ts";
import { tarballFilename, type CodeReviewProvider, type RepoSource } from "@corbits/triage-contracts";
import { WORKFLOW_PACKAGES, type PackageIndexEntry, type WorkflowKind, type WorkflowPackage } from "./workflow-packages.ts";

const REGISTRY_NAME = "corbits";

type Asset = { id: string; kind: string; name: string };

async function ensureAsset(transport: Transport, tenantId: string, kind: "workflow" | "package-registry", name: string): Promise<Asset> {
  const base = `/api/tenants/${encodeURIComponent(tenantId)}/assets`;
  const assets = await transport.fetch<Asset[]>("GET", `${base}?kind=${kind}`);
  return assets.find((asset) => asset.name === name)
    ?? transport.fetch<Asset>("POST", base, { kind, name });
}

async function portalPackage(fetchRaw: typeof fetch, file: string): Promise<Response> {
  const response = await fetchRaw(`/packages/${file}`);
  if (!response.ok) throw new Error(`The portal build is missing ${file}.`);
  return response;
}

async function putTarball(fetchRaw: typeof fetch, tenantId: string, registryId: string, entry: PackageIndexEntry, bytes: ArrayBuffer): Promise<void> {
  const response = await fetchRaw(`${requestOrigin()}${tarballPath(tenantId, registryId, entry.filename)}`, {
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

function tarballPath(tenantId: string, registryId: string, filename?: string): string {
  const base = `/api/tenants/${encodeURIComponent(tenantId)}/assets/${encodeURIComponent(registryId)}/tarballs`;
  return filename === undefined ? base : `${base}/${encodeURIComponent(filename)}`;
}

/**
 * Interchange delivers a workflow the registry's whole tip tree under a size
 * cap, so the registry keeps only this build's tarballs and those a live
 * deployment's closure pins; the asset's git history keeps the rest. Runs
 * before anything is published or deployed, so a registry already over the
 * cap shrinks before this build's deploy is probed. A version is never
 * overwritten, and a tarball already removed by another converge is skipped.
 */
async function syncRegistry(
  transport: Transport,
  fetchRaw: typeof fetch,
  tenantId: string,
  registryId: string,
  index: PackageIndexEntry[],
  deployments: readonly DeployedWorkflow[],
): Promise<void> {
  const listed = await transport.fetch<Array<{ filename: string; integrity: string }>>("GET", tarballPath(tenantId, registryId));
  const missing: PackageIndexEntry[] = [];
  for (const entry of index) {
    const existing = listed.find((tarball) => tarball.filename === entry.filename);
    if (!existing) missing.push(entry);
    else if (existing.integrity !== entry.integrity) {
      throw new Error(`${entry.name}@${entry.version} is already published with different contents; this build did not pack reproducibly.`);
    }
  }
  const kept = new Set(index.map((entry) => entry.filename));
  for (const deployment of deployments) {
    for (const pkg of [deployment.package, ...deployment.tools]) if (pkg) kept.add(tarballFilename(pkg));
  }
  for (const { filename } of listed) {
    if (!kept.has(filename)) await deleteTarball(transport, tenantId, registryId, filename);
  }
  // In index order, so the tools and native modules land before the workflows that depend on them.
  for (const entry of missing) {
    await putTarball(fetchRaw, tenantId, registryId, entry, await (await portalPackage(fetchRaw, entry.filename)).arrayBuffer());
  }
}

async function deleteTarball(transport: Transport, tenantId: string, registryId: string, filename: string): Promise<void> {
  try {
    await transport.fetch("DELETE", tarballPath(tenantId, registryId, filename));
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
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
  return deployed || workflow === "pr-triage-historical";
}

/** The hub refuses a host's workflow while that host is not connected, which can change after the portal read it. */
function sourceNotConnected(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409 && cause.code === "source_not_connected";
}

/**
 * The hosts the workspace connected, those whose code review is on, the provider it runs code review on, and the hosts
 * whose PR workflow deploys, undefined when the hub did not say.
 */
export type DeployHosts = { connected: readonly RepoSource[]; codeReview: readonly RepoSource[]; codeReviewProvider: CodeReviewProvider | undefined; prWorkflow: readonly RepoSource[] | undefined };

function wanted(workflow: WorkflowPackage, hosts: DeployHosts): boolean {
  if (!hosts.connected.includes(workflow.source)) return false;
  if (workflow.kind === "triage") return true;
  if (workflow.provider !== hosts.codeReviewProvider) return false;
  if (workflow.kind === "pr-workflow") return hosts.prWorkflow?.includes(workflow.source) === true;
  return hosts.codeReview.includes(workflow.source);
}

/** The PR workflow follows the policy files: once none needs it on a host, or its key is gone, its deployment goes. */
async function releaseUnwanted(transport: Transport, tenantId: string, hosts: DeployHosts, deployments: readonly DeployedWorkflow[]): Promise<void> {
  if (hosts.prWorkflow === undefined) return;
  const unwanted = new Set<string>(WORKFLOW_PACKAGES.filter((workflow) => workflow.kind === "pr-workflow" && !wanted(workflow, hosts)).map((workflow) => workflow.name));
  for (const deployment of deployments) {
    if (unwanted.has(deployment.workflow) && !deployment.cancelling && !deployment.worker) await cancelDeployment(transport, tenantId, deployment.id);
  }
}

/** Each host's triage deploys while the host is connected, its code review while that is on too, its PR workflow while a repository's policy file needs it; `redeploy` names the kinds deployed again even at the same version. */
export async function ensureWorkflows(
  transport: Transport,
  tenantId: string,
  hosts: DeployHosts,
  redeploy: ReadonlySet<WorkflowKind>,
  fetchRaw: typeof fetch = fetch,
): Promise<string[]> {
  const deployments = await listDeployedWorkflows(transport, tenantId);
  await ensureKeepDeployedLifetime(transport, tenantId);
  const registry = await ensureAsset(transport, tenantId, "package-registry", REGISTRY_NAME);
  const index = await (await portalPackage(fetchRaw, "index.json")).json() as PackageIndexEntry[];
  await syncRegistry(transport, fetchRaw, tenantId, registry.id, index, deployments);
  const deployed: string[] = [];
  for (const workflow of WORKFLOW_PACKAGES.filter((row) => wanted(row, hosts))) {
    const pkg = index.find((entry) => entry.name === workflow.packageName);
    if (!pkg) throw new Error(`The portal build is missing the ${workflow.name} workflow.`);
    // The deploy route needs a workflow asset to name the definition; the code comes from the registry.
    const asset = await ensureAsset(transport, tenantId, "workflow", workflow.name);
    const current = currentDeployment(deployments, workflow.name)?.package;
    const deploy = redeploy.has(workflow.kind) || current?.name !== pkg.name || current.version !== pkg.version;
    if (deploy) {
      const offerings = await offeringsFor(transport, tenantId, workflow.models);
      try {
        await transport.fetch<WorkflowDeployment>("POST", `/api/integrations/workflow-deploy/${encodeURIComponent(tenantId)}`, {
          registryAssetId: registry.id,
          definitionAssetId: asset.id,
          pin: `${pkg.name}@${pkg.version}`,
          entry: workflow.entry,
          sourceOfferingIds: offerings.ids,
          defaultSourceOfferingId: offerings.defaultId,
        });
      } catch (cause) {
        if (sourceNotConnected(cause)) continue;
        throw cause;
      }
      deployed.push(workflow.name);
    }
    if (cancelsSuperseded(workflow.name, deploy)) await cancelSuperseded(transport, tenantId, asset.id);
  }
  await releaseUnwanted(transport, tenantId, hosts, deployments);
  return deployed;
}

/** Releases the live deployments of one kind of workflow, such as code review once the Anthropic key it runs on is removed. */
export async function releaseWorkflows(transport: Transport, tenantId: string, kind: WorkflowKind): Promise<void> {
  const names = new Set<string>(WORKFLOW_PACKAGES.filter((workflow) => workflow.kind === kind).map((workflow) => workflow.name));
  for (const deployment of await listDeployedWorkflows(transport, tenantId)) {
    if (names.has(deployment.workflow) && !deployment.cancelling) await cancelDeployment(transport, tenantId, deployment.id);
  }
}
