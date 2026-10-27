// A repository's policy is its policy file on the default branch (see policy-file.ts), and nothing else: a repository
// without one runs no triage. A policy file that extends another repository is resolved against that repository's
// policy file as the hub last read it, so each mail carries the pack and the versions it was built from.
import { checkPolicyFile, extendedFilePack, extendsOf, POLICY_FILE_PATH, policyFileReason, readCheckPack, refuseUnknownChecks, type ActionKind, type CheckPack, type PolicyFileRef, type PolicySource, type PolicyWorkflow, type RepoSource, type SharedFileRef } from "@corbits/triage-contracts";
import type { PolicyFileState } from "./policy-file.js";
import { prWorkflowKeys } from "./pr-workflow.js";

/**
 * `automatic` is the Do kinds the pr-triage role is granted on the repository; `source` is what `pack` was resolved from;
 * `policyWorkflow` the policy file's v4 keys while only the PR workflow can run them; `pauseLabel` the file's, whichever runs it.
 */
export type ResolvedPack = { pack: CheckPack; automatic: ActionKind[]; source: PolicySource; policyWorkflow?: PolicyWorkflow; pauseLabel?: string };

function withPrWorkflowKeys(workflow: PolicyWorkflow, pack: CheckPack): Pick<ResolvedPack, "policyWorkflow"> {
  const policyWorkflow = prWorkflowKeys(workflow, pack);
  return policyWorkflow ? { policyWorkflow } : {};
}

/** `missing`: the repository has no policy file; `invalid`: it has one triage refuses. */
export type CheckPackRead =
  | ({ status: "ok" } & ResolvedPack)
  | { status: "missing" }
  | { status: "invalid"; reason: string; path: string; automatic: ActionKind[] };

/** `source` is the repository's host; a caller without one reads no file where both hosts hold the name. */
type PolicyFileReader = (tenantId: string, repo: string, source: RepoSource | undefined) => Promise<PolicyFileState>;

/** The policy triage runs on for `repo` on `source`. */
export type PolicyReader = (tenantId: string, repo: string, source: RepoSource) => Promise<CheckPackRead>;

export type RepoPolicyDeps = {
  policyFile: PolicyFileReader;
  automaticKinds: (tenantId: string, repo: string) => Promise<ActionKind[]>;
};

/** Over the policy file of the repository `extends` names, read with this workspace's own access to it. */
async function overSharedFile(policyFile: PolicyFileReader, tenantId: string, repo: string, source: RepoSource | undefined, content: Record<string, unknown>, shared: string): Promise<Pick<ResolvedPack, "pack"> & { sharedFile: SharedFileRef }> {
  const state = await policyFile(tenantId, shared, source);
  if (state.status === "absent") throw new Error(`${shared} is not connected to this workspace or has no policy file.`);
  if (state.status === "invalid") throw new Error(`${shared}'s policy file is refused: ${state.reason}`);
  return { pack: extendedFilePack(repo, content, { repo: shared, policy: state.policy }), sharedFile: { repo: shared, path: state.file.path, sha: state.file.sha } };
}

async function fileResolved(deps: RepoPolicyDeps, tenantId: string, repo: string, source: RepoSource | undefined, content: Record<string, unknown>) {
  const shared = extendsOf(content);
  if (shared !== undefined) return overSharedFile(deps.policyFile, tenantId, repo, source, content, shared);
  refuseUnknownChecks(content);
  return { pack: readCheckPack(content, repo) };
}

/** Why triage would refuse a policy file holding `policy`, resolved as a pushed file is; undefined when it would run it. */
export async function fileRefusal(deps: RepoPolicyDeps, tenantId: string, repo: string, source: RepoSource | undefined, policy: Record<string, unknown>): Promise<string | undefined> {
  try {
    await fileResolved(deps, tenantId, repo, source, policy);
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
}

/** `file` names the file `policy` was read from; a policy not yet in a file has none. */
async function resolvedRead(deps: RepoPolicyDeps, tenantId: string, repo: string, source: RepoSource, path: string, file: PolicyFileRef | undefined, policy: Record<string, unknown>, workflow: PolicyWorkflow): Promise<CheckPackRead> {
  let read: Awaited<ReturnType<typeof fileResolved>>;
  try {
    read = await fileResolved(deps, tenantId, repo, source, policy);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { status: "invalid", reason: error.message, path, automatic: await deps.automaticKinds(tenantId, repo) };
  }
  const { pack, ...from } = read;
  const resolved: PolicySource = { ...(file && { file }), ...from };
  return { status: "ok", pack, source: resolved, automatic: await deps.automaticKinds(tenantId, repo), ...withPrWorkflowKeys(workflow, pack), ...(workflow.pauseLabel && { pauseLabel: workflow.pauseLabel }) };
}

export async function readRepoPolicy(deps: RepoPolicyDeps, tenantId: string, repo: string, source: RepoSource): Promise<CheckPackRead> {
  const file = await deps.policyFile(tenantId, repo, source);
  if (file.status === "absent") return { status: "missing" };
  if (file.status === "invalid") return { status: "invalid", reason: file.reason, path: file.path, automatic: await deps.automaticKinds(tenantId, repo) };
  return resolvedRead(deps, tenantId, repo, source, file.file.path, { path: file.file.path, sha: file.file.sha }, file.policy, file.workflow);
}

/** The policy triage would run on once `text` is the repository's policy file, read as a pushed file is. */
export async function previewRepoPolicy(deps: RepoPolicyDeps, tenantId: string, repo: string, source: RepoSource, text: string): Promise<CheckPackRead> {
  const checked = checkPolicyFile(text, repo);
  if (!checked.ok) return { status: "invalid", reason: policyFileReason(checked.problems), path: POLICY_FILE_PATH, automatic: await deps.automaticKinds(tenantId, repo) };
  return resolvedRead(deps, tenantId, repo, source, POLICY_FILE_PATH, undefined, checked.policy, checked.workflow);
}
