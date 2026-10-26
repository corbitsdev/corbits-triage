// One pr-triage package per pull request host, each binding only its host's credential because an unresolved binding
// fails a deployment: a workspace deploys the packages of the hosts it connected, and each repository's mail goes to
// its host's workflow.
import { and, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { CODE_REVIEW_PROVIDERS, codeReviewProviderOf, TRIAGE_MANAGERS, type RepoSource } from "@corbits/triage-contracts";
import { PR_TRIAGE_ADDRESS } from "@corbits/triage-workflows/pr-triage";
import { PR_TRIAGE_BITBUCKET_DATACENTER_ADDRESS, workflow as prTriageBitbucket } from "@corbits/triage-workflows/pr-triage-bitbucket-datacenter";
import { PR_TRIAGE_GITHUB_ADDRESS, workflow as prTriageGithub } from "@corbits/triage-workflows/pr-triage-github";
import { PR_CODE_REVIEW_BITBUCKET_DATACENTER_ADDRESS, PR_CODE_REVIEW_GITHUB_ADDRESS } from "@corbits/pr-code-review/pr-code-review";
import { PR_WORKFLOW_VARIANTS, prWorkflowVariantOf } from "./pr-workflow.js";
import { repoRecords, ROTATION_KEY, sourceOf, triageNs } from "./tenant-config.js";

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

/** Code review per host, binding that host's read credential; it is deployed while a repository of the host has it on, from the package of the workspace's code review provider. */
export type CodeReviewWorkflow = { source: RepoSource; id: string; entry: string };

export const CODE_REVIEW_WORKFLOWS: readonly CodeReviewWorkflow[] = [
  { source: "github", id: PR_CODE_REVIEW_GITHUB_ADDRESS, entry: "./pr-code-review-github.mjs" },
  { source: "bitbucket-datacenter", id: PR_CODE_REVIEW_BITBUCKET_DATACENTER_ADDRESS, entry: "./pr-code-review-bitbucket-datacenter.mjs" },
];

/** The workflow id deployed before hosts, which GitHub hook credentials still name; its mail now goes to the GitHub workflow. */
const LEGACY_TRIAGE_WORKFLOW = PR_TRIAGE_ADDRESS;

/** pr-triage-historical binds the GitHub App only, so it deploys for workspaces with GitHub connected. */
const HISTORICAL_ENTRY = "./pr-triage-historical.mjs";

export function triageWorkflowFor(source: RepoSource): TriageWorkflow {
  return TRIAGE_WORKFLOWS.find((workflow) => workflow.source === source)!;
}

/** The host's workflow the deploy route or a hook names, by package entry or workflow id; undefined for any other workflow. */
export function triageWorkflowOf(entryOrId: string): TriageWorkflow | undefined {
  if (entryOrId === LEGACY_TRIAGE_WORKFLOW) return triageWorkflowFor("github");
  return TRIAGE_WORKFLOWS.find((workflow) => workflow.entry === entryOrId || workflow.id === entryOrId);
}

export function codeReviewWorkflowFor(source: RepoSource): CodeReviewWorkflow {
  return CODE_REVIEW_WORKFLOWS.find((workflow) => workflow.source === source)!;
}

/** Every workflow a host's pull request job can run in: its triage, its code review and its PR workflow variants. */
export function jobWorkflowsFor(source: RepoSource): string[] {
  const variants = PR_WORKFLOW_VARIANTS.filter((variant) => variant.source === source).map((variant) => variant.id);
  return [triageWorkflowFor(source).id, codeReviewWorkflowFor(source).id, ...variants];
}

/** Every workflow whose runs record a host's verdicts: its jobs' and its pull request manager. */
export function verdictWorkflowsFor(source: RepoSource): string[] {
  return [...jobWorkflowsFor(source), TRIAGE_MANAGERS[source]];
}

/** The host whose credential a package entry binds; undefined for an entry that binds none. */
export function entrySource(entry: string): RepoSource | undefined {
  if (entry === HISTORICAL_ENTRY) return "github";
  return (triageWorkflowOf(entry) ?? CODE_REVIEW_WORKFLOWS.find((workflow) => workflow.entry === entry) ?? prWorkflowVariantOf(entry))?.source;
}

/** The names of the code review provider credentials the workspace holds active; names only, never secrets. */
async function codeReviewKeys(db: DB["db"], tenantId: string): Promise<string[]> {
  const credentials = Object.values(CODE_REVIEW_PROVIDERS).map((provider) => provider.credential);
  const rows = await db.query.credential.findMany({
    where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.status, "active"), inArray(schema.credential.name, credentials)),
    columns: { name: true },
  });
  return rows.map((row) => row.name);
}

/** Whether the workspace stores a code review provider's key. */
export async function hasCodeReviewKey(db: DB["db"], tenantId: string): Promise<boolean> {
  return codeReviewProviderOf(await codeReviewKeys(db, tenantId)) !== undefined;
}

/** The hosts with a connected repository that has code review on, while a code review provider's key is stored. */
export async function codeReviewSources(db: DB["db"], tenantId: string): Promise<RepoSource[]> {
  if (!(await hasCodeReviewKey(db, tenantId))) return [];
  const tenant = await db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
  const reviewed = repoRecords(triageNs(tenant?.config)).filter((record) => record.connected && record.codeReview === true);
  return [...new Set(reviewed.map(sourceOf))];
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

type SourceDeploymentsDeps = {
  connectedSources: (tenantId: string) => Promise<RepoSource[]>;
  codeReviewSources: (tenantId: string) => Promise<RepoSource[]>;
  codeReviewPlaced: (tenantId: string) => Promise<boolean>;
  liveDeployments: (tenantId: string, workflow: string) => Promise<Array<{ runId: string; cancelling: boolean }>>;
  release: (tenantId: string, anchorRunId: string) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
};

/**
 * Keeps a workspace's pr-triage deployments to the hosts it connected: a disconnected host's live deployment is released,
 * and a connected host without one is logged for the portal to deploy, which only it can, as it publishes the packages.
 * A deployment of the workflow from before hosts is released once the GitHub one is live. A host's code review is
 * released once no repository of it has code review on, the Anthropic key is gone, or no provisioner can run it; a host's
 * PR workflow variant once the host is disconnected or no provisioner can run it; the portal releases it with its key.
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
    const placed = await deps.codeReviewPlaced(tenantId);
    const reviewed = await deps.codeReviewSources(tenantId);
    for (const workflow of CODE_REVIEW_WORKFLOWS) {
      if (!placed) await releaseAll(tenantId, workflow.id, "no_isolated_place");
      else if (!connected.includes(workflow.source) || !reviewed.includes(workflow.source)) await releaseAll(tenantId, workflow.id, "code_review_off");
    }
    for (const variant of PR_WORKFLOW_VARIANTS) {
      if (!placed) await releaseAll(tenantId, variant.id, "no_isolated_place");
      else if (!connected.includes(variant.source)) await releaseAll(tenantId, variant.id, "source_disconnected");
    }
    if ((await deps.liveDeployments(tenantId, triageWorkflowFor("github").id)).some((deployment) => !deployment.cancelling)) {
      await releaseAll(tenantId, LEGACY_TRIAGE_WORKFLOW, "superseded_by_pr_triage_github");
    }
  };
}
