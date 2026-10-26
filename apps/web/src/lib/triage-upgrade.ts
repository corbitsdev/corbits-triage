// Switching a workspace to the per-pull-request manager: publish this portal's release as the person upgrading, deploy
// each connected host's listener from it, and stop every other listener of that host once the new one is up.
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { deployWorkflow, listWorkflowDeployments, type Transport, type WorkflowDeployment } from "@intx/hub-client";
import { TRIAGE_LISTENERS, type RepoSource } from "@corbits/triage-contracts";
import { isDeployerRole, isOwnerRole } from "./automation-grid.ts";
import { connectedSources, currentDeployment, isLiveDeployment, listDeployedWorkflows, pause, type DeployedWorkflow } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { offeringsFor } from "./model-catalog.ts";
import { TRIAGE_RELEASE_QUERY_KEY, usePortal } from "./portal.tsx";
import { usePrincipals, useRoles } from "./tenant-entities.ts";
import { cancelDeployment, portalPackage } from "./workflow-deploy.ts";
import { CHAIN_PACKAGES, type SourceIndexEntry } from "./workflow-packages.ts";
import { publishSources, type PublishedSource, type Publisher } from "./workflow-sources.ts";

export type UpgradeStep = "publishing" | "starting" | "stopping";

export const UPGRADE_STEP_LABEL: Record<UpgradeStep, string> = { publishing: "Publishing the new version…", starting: "Starting the new version…", stopping: "Stopping the old version…" };

const START_DEADLINE_MS = 5 * 60_000;
const START_POLL_MS = 2_000;
const FAILED_STATUSES = new Set(["failed", "cancelled", "released"]);

type Asset = { id: string; name: string; creatorPrincipalId: string | null };

/** A host's live listener: the release it runs, by its build hash, and who published it. */
export type RunningListener = { source: RepoSource; release: string | undefined; publisherPrincipalId: string | null; since: string };
/** This portal's release by each workflow's build hash, and the listeners running now. */
export type TriageRelease = { portal: SourceIndexEntry[]; running: RunningListener[] };

function chainOf(workflow: string) {
  const chain = CHAIN_PACKAGES.find((row) => row.name === workflow);
  if (!chain) throw new Error(`The portal build has no ${workflow}.`);
  return chain;
}

/** A source-built version ends in its build hash, which is also the release's name for it. */
function buildHash(version: string): string {
  return version.slice(version.lastIndexOf("-") + 1);
}

export function portalRelease(portal: readonly SourceIndexEntry[], source: RepoSource): string | undefined {
  return portal.find((entry) => entry.workflow === TRIAGE_LISTENERS[source])?.hash;
}

async function waitUntilStarted(transport: Transport, tenantId: string, id: string): Promise<void> {
  const deadline = Date.now() + START_DEADLINE_MS;
  while (Date.now() < deadline) {
    const deployment = (await listWorkflowDeployments(transport, tenantId)).find((row) => row.id === id);
    if (deployment && isLiveDeployment(deployment.status)) return;
    if (deployment && FAILED_STATUSES.has(deployment.status)) throw new Error("The new version did not start, so the current one keeps running.");
    await pause(START_POLL_MS);
  }
  throw new Error("The new version did not start within five minutes, so the current one keeps running.");
}

/** Every other live listener of the host, whoever published it. */
async function stopOtherListeners(transport: Transport, tenantId: string, source: RepoSource, keep: string): Promise<void> {
  for (const deployment of await listDeployedWorkflows(transport, tenantId)) {
    if (deployment.workflow === TRIAGE_LISTENERS[source] && deployment.id !== keep && !deployment.cancelling && !deployment.worker) await cancelDeployment(transport, tenantId, deployment.id);
  }
}

async function deployListener(transport: Transport, tenantId: string, source: RepoSource, published: readonly PublishedSource[]): Promise<WorkflowDeployment> {
  const workflow = TRIAGE_LISTENERS[source];
  const listener = published.find((row) => row.workflow === workflow);
  if (!listener) throw new Error("Add a decision model before upgrading.");
  const chain = chainOf(workflow);
  const offerings = await offeringsFor(transport, tenantId, chain.models);
  return deployWorkflow(transport, tenantId, {
    source: { kind: "asset", assetId: listener.assetId, package: { format: "source", commitSha: listener.commitSha, packageName: chain.packageName } },
    entry: chain.entry,
    sourceOfferingIds: offerings.ids,
    defaultSourceOfferingId: offerings.defaultId,
  });
}

export async function upgradeTriage(
  transport: Transport,
  publisher: Publisher,
  sources: readonly RepoSource[],
  onStep: (step: UpgradeStep) => void,
  publish: (transport: Transport, publisher: Publisher) => Promise<PublishedSource[]> = publishSources,
): Promise<void> {
  onStep("publishing");
  const published = await publish(transport, publisher);
  for (const source of sources) {
    onStep("starting");
    const deployment = await deployListener(transport, publisher.tenantId, source, published);
    await waitUntilStarted(transport, publisher.tenantId, deployment.id);
    onStep("stopping");
    await stopOtherListeners(transport, publisher.tenantId, source, deployment.id);
  }
}

function runningOn(source: RepoSource, deployed: readonly DeployedWorkflow[], deployments: readonly WorkflowDeployment[], assets: readonly Asset[]): RunningListener | undefined {
  const live = currentDeployment(deployed, TRIAGE_LISTENERS[source]);
  if (!live) return undefined;
  const assetId = deployments.find((row) => row.id === live.id)?.definitionAssetId;
  const asset = assets.find((row) => row.id === assetId);
  return { source, release: live.package ? buildHash(live.package.version) : undefined, publisherPrincipalId: asset?.creatorPrincipalId ?? null, since: live.createdAt };
}

async function readPortalIndex(fetchRaw: typeof fetch): Promise<SourceIndexEntry[]> {
  return await (await portalPackage(fetchRaw, "sources/index.json")).json() as SourceIndexEntry[];
}

export async function readTriageRelease(transport: Transport, tenantId: string, sources: readonly RepoSource[], fetchRaw: typeof fetch = fetch): Promise<TriageRelease> {
  const [portal, deployed, deployments, assets] = await Promise.all([
    readPortalIndex(fetchRaw),
    listDeployedWorkflows(transport, tenantId),
    listWorkflowDeployments(transport, tenantId),
    transport.fetch<Asset[]>("GET", `/api/tenants/${encodeURIComponent(tenantId)}/assets?kind=workflow`),
  ]);
  const running = sources.map((source) => runningOn(source, deployed, deployments, assets)).filter((row) => row !== undefined);
  return { portal, running };
}

/** Upgrade is offered while a connected host runs no listener, or one from another release than this portal's. */
export function upgradeDue(release: TriageRelease, sources: readonly RepoSource[]): boolean {
  return sources.some(function behind(source) {
    const running = release.running.find((row) => row.source === source);
    return !running || running.release !== portalRelease(release.portal, source);
  });
}

/** Owners hold every grant, and the Deployer role every grant publishing needs. */
export function useMayUpgrade(): boolean {
  const { snapshot } = usePortal();
  const people = usePrincipals();
  const roles = useRoles();
  const you = people.rows.find((person) => person.id === snapshot?.workspace.principalId);
  const upgraders = new Set(roles.rows.filter((role) => isOwnerRole(role) || isDeployerRole(role)).map((role) => role.id));
  return you?.roles.some((role) => upgraders.has(role.id)) === true;
}

export function useTriageRelease() {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const sources = snapshot ? connectedSources(snapshot.credentials) : [];
  return useQuery({
    queryKey: [TRIAGE_RELEASE_QUERY_KEY, tenantId, sources],
    queryFn: tenantId === undefined ? skipToken : function readRelease() {
      return readTriageRelease(createHubTransport(), tenantId, sources);
    },
  });
}

export function useTriageUpgrade(onStep: (step: UpgradeStep) => void) {
  const { snapshot, refresh } = usePortal();
  return useMutation({
    async mutationFn() {
      if (!snapshot) throw new Error("The service is unavailable. Reload the page and try again.");
      const { tenantId, principalId } = snapshot.workspace;
      await upgradeTriage(createHubTransport(), { tenantId, principalId }, connectedSources(snapshot.credentials), onStep);
    },
    onSettled: refresh,
  });
}
