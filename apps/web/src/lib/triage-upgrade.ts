// Switching a workspace to the per-pull-request manager: publish this portal's release as the person upgrading, deploy
// each connected host's listener from it, and once it is up stop that host's listeners deployed before it.
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { deployWorkflow, listWorkflowDeployments, type Transport, type WorkflowDeployment } from "@intx/hub-client";
import { TRIAGE_LISTENERS, type RepoSource } from "@corbits/triage-contracts";
import { isDeployerRole, isOwnerRole } from "./automation-grid.ts";
import { connectedSources, isLiveDeployment, listDeployedWorkflows, pause, type DeployedWorkflow } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { offeringsFor } from "./model-catalog.ts";
import { TRIAGE_RELEASE_QUERY_KEY, usePortal } from "./portal.tsx";
import { usePrincipals, useRoles } from "./tenant-entities.ts";
import { cancelDeployment, portalPackage } from "./workflow-deploy.ts";
import { CHAIN_PACKAGES, type SourceIndexEntry } from "./workflow-packages.ts";
import { publishSources, type PublishedSource, type Publisher } from "./workflow-sources.ts";

export type UpgradeStep = "publishing" | "starting" | "stopping";

export const SOURCE_NAME: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket Data Center" };

export const UPGRADE_STEP_LABEL: Record<UpgradeStep, string> = { publishing: "Publishing the new version…", starting: "Starting the new version…", stopping: "Stopping the old version…" };

const START_DEADLINE_MS = 5 * 60_000;
const START_POLL_MS = 2_000;
const FAILED_STATUSES = new Set(["failed", "cancelled", "released"]);

type Asset = { id: string; name: string; creatorPrincipalId: string | null };

/** A host's newest live listener: its package version, the release's build hash, and who published it. */
export type RunningListener = { version: string | undefined; release: string | undefined; publisherPrincipalId: string | null; since: string };
/** A connected host: its newest live listener, and how many are live. */
export type HostRelease = { source: RepoSource; running: RunningListener | undefined; live: number };
/** This portal's release by each workflow's build hash, and each connected host's listeners. */
export type TriageRelease = { portal: SourceIndexEntry[]; hosts: HostRelease[] };

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
  await cancelDeployment(transport, tenantId, id);
  throw new Error("The new version did not start within five minutes, so the current one keeps running.");
}

function olderThan(deployment: { id: string; createdAt: string }, newer: WorkflowDeployment): boolean {
  return deployment.createdAt < newer.createdAt || (deployment.createdAt === newer.createdAt && deployment.id < newer.id);
}

/** Only listeners deployed before this one, whoever published them, so of two upgrades at once the newer stays. */
async function stopOlderListeners(transport: Transport, tenantId: string, source: RepoSource, started: WorkflowDeployment): Promise<void> {
  for (const deployment of await listDeployedWorkflows(transport, tenantId)) {
    if (deployment.workflow === TRIAGE_LISTENERS[source] && olderThan(deployment, started) && !deployment.cancelling && !deployment.worker) await cancelDeployment(transport, tenantId, deployment.id);
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
    try {
      onStep("starting");
      const deployment = await deployListener(transport, publisher.tenantId, source, published);
      await waitUntilStarted(transport, publisher.tenantId, deployment.id);
      onStep("stopping");
      await stopOlderListeners(transport, publisher.tenantId, source, deployment);
    } catch (cause: unknown) {
      throw new Error(`${SOURCE_NAME[source]}: ${errorText(cause)}`, { cause });
    }
  }
}

function hostOf(source: RepoSource, deployed: readonly DeployedWorkflow[], deployments: readonly WorkflowDeployment[], assets: readonly Asset[]): HostRelease {
  const listeners = deployed.filter((row) => row.workflow === TRIAGE_LISTENERS[source] && !row.cancelling && !row.worker);
  const [newest] = [...listeners].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  if (!newest) return { source, running: undefined, live: 0 };
  const assetId = deployments.find((row) => row.id === newest.id)?.definitionAssetId;
  const asset = assets.find((row) => row.id === assetId);
  const running = {
    version: newest.package?.version,
    release: newest.package ? buildHash(newest.package.version) : undefined,
    publisherPrincipalId: asset?.creatorPrincipalId ?? null,
    since: newest.createdAt,
  };
  return { source, running, live: listeners.length };
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
  return { portal, hosts: sources.map((source) => hostOf(source, deployed, deployments, assets)) };
}

/** Upgrade is offered while a host runs no listener, one from another release than this portal's, or more than one. */
export function upgradeDue(release: TriageRelease, host: HostRelease): boolean {
  return !host.running || host.live > 1 || host.running.release !== portalRelease(release.portal, host.source);
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
