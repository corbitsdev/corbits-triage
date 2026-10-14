// One pr-triage package per pull request host, each binding only its host's credential because an unresolved binding
// fails a deployment: a workspace deploys the packages of the hosts it connected, and each repository's mail goes to
// its host's workflow.
import { and, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import type { RepoSource } from "@corbits/triage-contracts";
import { PR_TRIAGE_ADDRESS } from "@corbits/triage-workflows/pr-triage";
import { PR_TRIAGE_BITBUCKET_DATACENTER_ADDRESS, workflow as prTriageBitbucket } from "@corbits/triage-workflows/pr-triage-bitbucket-datacenter";
import { PR_TRIAGE_GITHUB_ADDRESS, workflow as prTriageGithub } from "@corbits/triage-workflows/pr-triage-github";
import { ROTATION_KEY } from "./tenant-config.js";

export type TriageWorkflow = {
  source: RepoSource;
  id: string;
  address: string;
  /** The portal's package entry, which the deploy route sees. */
  entry: string;
  credential: string;
  /** Where the tenant config records this workflow's deployment rotation; GitHub's keeps the key from before hosts. */
  rotationKey: string;
};

export const TRIAGE_WORKFLOWS: readonly TriageWorkflow[] = [
  { source: "github", id: prTriageGithub.id, address: PR_TRIAGE_GITHUB_ADDRESS, entry: "./pr-triage-github.mjs", credential: "github", rotationKey: ROTATION_KEY },
  { source: "bitbucket-datacenter", id: prTriageBitbucket.id, address: PR_TRIAGE_BITBUCKET_DATACENTER_ADDRESS, entry: "./pr-triage-bitbucket-datacenter.mjs", credential: "bitbucket-datacenter", rotationKey: "rotationBitbucketDatacenter" },
];

/** The workflow id deployed before hosts, which GitHub hook credentials still name; its mail now goes to the GitHub workflow. */
export const LEGACY_TRIAGE_WORKFLOW = PR_TRIAGE_ADDRESS;

/** pr-triage-historical binds the GitHub App only, so it deploys for workspaces with GitHub connected. */
export const HISTORICAL_ENTRY = "./pr-triage-historical.mjs";

export function triageWorkflowFor(source: RepoSource): TriageWorkflow {
  return TRIAGE_WORKFLOWS.find((workflow) => workflow.source === source)!;
}

/** The host's workflow the deploy route or a hook names, by package entry or workflow id; undefined for any other workflow. */
export function triageWorkflowOf(entryOrId: string): TriageWorkflow | undefined {
  if (entryOrId === LEGACY_TRIAGE_WORKFLOW) return triageWorkflowFor("github");
  return TRIAGE_WORKFLOWS.find((workflow) => workflow.entry === entryOrId || workflow.id === entryOrId);
}

/** The hosts whose credential the workspace holds. */
export async function connectedSources(db: DB["db"], tenantId: string): Promise<RepoSource[]> {
  const credentials = TRIAGE_WORKFLOWS.map((workflow) => workflow.credential);
  const rows = await db.query.credential.findMany({
    where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.status, "active"), inArray(schema.credential.name, credentials)),
    columns: { name: true },
  });
  const names = new Set(rows.map((row) => row.name));
  return TRIAGE_WORKFLOWS.filter((workflow) => names.has(workflow.credential)).map((workflow) => workflow.source);
}

export type SourceDeploymentsDeps = {
  connectedSources: (tenantId: string) => Promise<RepoSource[]>;
  liveDeployments: (tenantId: string, workflow: string) => Promise<Array<{ runId: string; cancelling: boolean }>>;
  release: (tenantId: string, anchorRunId: string) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
};

/**
 * Keeps a workspace's pr-triage deployments to the hosts it connected: a disconnected host's live deployment is released,
 * and a connected host without one is logged for the portal to deploy, which only it can, as it publishes the packages.
 * A deployment of the workflow from before hosts is released once the GitHub one is live.
 */
export function createSourceDeployments(deps: SourceDeploymentsDeps) {
  async function releaseAll(tenantId: string, workflow: string, reason: string): Promise<void> {
    for (const live of await deps.liveDeployments(tenantId, workflow)) {
      if (live.cancelling) continue;
      await deps.release(tenantId, live.runId);
      deps.log({ level: "info", msg: "triage_deployment_released", tenantId, workflow, deployment: live.runId, reason });
    }
  }

  return async function reconcileSourceDeployments(tenantId: string): Promise<void> {
    const connected = await deps.connectedSources(tenantId);
    for (const workflow of TRIAGE_WORKFLOWS) {
      if (!connected.includes(workflow.source)) {
        await releaseAll(tenantId, workflow.id, "source_disconnected");
        continue;
      }
      const live = await deps.liveDeployments(tenantId, workflow.id);
      if (live.some((deployment) => !deployment.cancelling)) continue;
      deps.log({ level: "warn", msg: "triage_deployment_missing", tenantId, workflow: workflow.id, source: workflow.source });
    }
    if ((await deps.liveDeployments(tenantId, triageWorkflowFor("github").id)).some((deployment) => !deployment.cancelling)) {
      await releaseAll(tenantId, LEGACY_TRIAGE_WORKFLOW, "superseded_by_pr_triage_github");
    }
  };
}
