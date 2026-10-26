// Shared by publishing and upgrading: workflow assets, the portal build's files, a workspace's deployment lifetime and
// cancelling a deployment.
import { ApiError, type Transport } from "@intx/hub-client";

type Asset = { id: string; kind: string; name: string; creatorPrincipalId: string | null };

export async function ensureAsset(transport: Transport, tenantId: string, name: string): Promise<Asset> {
  const base = `/api/tenants/${encodeURIComponent(tenantId)}/assets`;
  const assets = await transport.fetch<Asset[]>("GET", `${base}?kind=workflow`);
  return assets.find((asset) => asset.name === name)
    ?? transport.fetch<Asset>("POST", base, { kind: "workflow", name });
}

export async function portalPackage(fetchRaw: typeof fetch, file: string): Promise<Response> {
  const response = await fetchRaw(`/packages/${file}`);
  if (!response.ok) throw new Error(`The portal build is missing ${file}.`);
  return response;
}

/** The longest lifetime Interchange accepts, so a deployment lives until a newer one replaces it. */
const KEEP_DEPLOYED_LIFETIME = "36500d";

/**
 * Interchange creates a workflow's definition during its first deploy, so a
 * per-definition lifecycle cannot apply to that deployment. The tenant only
 * runs triage workflows, so its ceiling keeps every listener deployed until a
 * newer one replaces it.
 */
export async function ensureKeepDeployedLifetime(transport: Transport, tenantId: string): Promise<void> {
  const path = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const { config } = await transport.fetch<{ config?: { lifecycle?: { maxLifetime?: string } } }>("GET", path);
  if (config?.lifecycle?.maxLifetime === KEEP_DEPLOYED_LIFETIME) return;
  await transport.fetch("PATCH", path, { config: { lifecycle: { ...config?.lifecycle, maxLifetime: KEEP_DEPLOYED_LIFETIME } } });
}

/** A deployment's id is its anchor run's id; 409 means it already stopped. */
export async function cancelDeployment(transport: Transport, tenantId: string, deploymentId: string): Promise<void> {
  try {
    await transport.fetch("DELETE", `/api/tenants/${encodeURIComponent(tenantId)}/workflows/runs/${encodeURIComponent(deploymentId)}`);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error;
  }
}
