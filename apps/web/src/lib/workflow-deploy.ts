// SPDX-License-Identifier: GPL-2.0-only
//
// The hub bridge finds deployments by workflow name, so each workflow is
// redeployed only when its source changed or no live deployment exists.
import { deployWorkflow, listWorkflowDeployments, type Transport } from "@intx/hub-client";
import { pushFiles } from "./git-push.ts";
import { requestOrigin } from "./hub-origin.ts";
import { isLiveDeployment } from "./hub-api.ts";
import { WORKFLOW_PACKAGES, workflowPackageFiles, type WorkflowPackage } from "./workflow-packages.ts";

/** Provider plugin the triage agents infer through (packages/triage-workflows/src/agents.ts). */
const INFERENCE_PLUGIN = "corbits-system-one";
const GIT_TOKEN_TTL_MS = 10 * 60_000;

type ModelInfo = { canonicalName: string; offerings: Array<{ offeringId: string; plugin: string; priority: number }> };
type Asset = { id: string; kind: string; name: string };

export type OfferingSuggestion = { ids: string[]; defaultId: string; model: string };

/** Offerings the triage agents can run on, lowest priority first; the first is the suggested default. */
export async function suggestOfferings(transport: Transport, tenantId: string): Promise<OfferingSuggestion | null> {
  const models = await transport.fetch<ModelInfo[]>("GET", `/api/tenants/${encodeURIComponent(tenantId)}/models`);
  const matches = models
    .flatMap((model) => model.offerings.filter((o) => o.plugin === INFERENCE_PLUGIN).map((o) => ({ ...o, model: model.canonicalName })))
    .sort((a, b) => a.priority - b.priority);
  const first = matches[0];
  return first ? { ids: matches.map((o) => o.offeringId), defaultId: first.offeringId, model: first.model } : null;
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

export async function ensureWorkflows(transport: Transport, tenantId: string, offerings: OfferingSuggestion): Promise<string[]> {
  const deployments = await listWorkflowDeployments(transport, tenantId);
  const deployed: string[] = [];
  for (const workflow of WORKFLOW_PACKAGES) {
    const asset = await ensureAsset(transport, tenantId, workflow.name);
    const { commitSha, changed } = await pushWorkflow(transport, tenantId, asset, workflow);
    const live = deployments.some((d) => d.definitionAssetId === asset.id && isLiveDeployment(d.status));
    if (live && !changed) continue;
    await deployWorkflow(transport, tenantId, {
      source: { kind: "asset", assetId: asset.id, package: { format: "source", commitSha, packageName: workflow.packageName } },
      entry: workflow.entry,
      sourceOfferingIds: offerings.ids,
      defaultSourceOfferingId: offerings.defaultId,
    });
    deployed.push(workflow.name);
  }
  return deployed;
}
