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

export type TriageWorkflow = {
  source: RepoSource;
  id: string;
  address: string;
  /** The portal's package entry, which the deploy route sees. */
  entry: string;
  credential: string;
};

export const TRIAGE_WORKFLOWS: readonly TriageWorkflow[] = [
  { source: "github", id: prTriageGithub.id, address: PR_TRIAGE_GITHUB_ADDRESS, entry: "./pr-triage-github.mjs", credential: "github" },
  { source: "bitbucket-datacenter", id: prTriageBitbucket.id, address: PR_TRIAGE_BITBUCKET_DATACENTER_ADDRESS, entry: "./pr-triage-bitbucket-datacenter.mjs", credential: "bitbucket-datacenter" },
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
