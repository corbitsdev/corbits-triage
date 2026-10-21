import { readRepoFileResponse, type RepoFileRead } from "@corbits/github-reads";
import { checkPolicyFile, notAFileReason, POLICY_FILE_PATHS, policyFileReason, readCheckPack, type CheckPack, type PolicyWorkflow } from "@corbits/triage-contracts";
import type { GithubApi } from "./github-api.ts";
import { keepPolicyFile, policyFiles } from "./storage.ts";

// A file read within this long is used as read; after it, GitHub is asked whether it changed.
const REVALIDATE_MS = 10 * 60 * 1000;

type FileOutcome = { kind: "absent" } | { kind: "policy"; path: string; url: string; policy: Record<string, unknown>; workflow: PolicyWorkflow } | { kind: "refused"; reason: string };

/** `etag` is the response for `path`, the name the file was found under. */
export type KeptPolicyFile = { path?: string; etag: string | null; checkedAt: string; outcome: FileOutcome };

export type PolicyRead = { pack: CheckPack; workflow: PolicyWorkflow; path: string; url: string };

function outcomeOf(read: RepoFileRead, repo: string, path: string): FileOutcome {
  if (read.kind === "not-a-file") return { kind: "refused", reason: notAFileReason(path) };
  if (read.text === null) return { kind: "refused", reason: `${path} is too large.` };
  const checked = checkPolicyFile(read.text, repo);
  if (!checked.ok) return { kind: "refused", reason: policyFileReason(checked.problems) };
  return { kind: "policy", path, url: read.url, policy: checked.policy, workflow: checked.workflow };
}

/** The file on the default branch, never a pull request's head, so a pull request cannot change the rules it is checked by. */
async function policyFile(api: GithubApi, repo: string, fresh: boolean): Promise<FileOutcome> {
  const kept = (await policyFiles.getValue())[repo];
  if (kept && !fresh && Date.now() - Date.parse(kept.checkedAt) < REVALIDATE_MS) return kept.outcome;
  const checkedAt = new Date().toISOString();
  for (const path of POLICY_FILE_PATHS) {
    const headers = new Headers({ accept: "application/vnd.github+json" });
    if (kept?.etag && kept.path === path) headers.set("if-none-match", kept.etag);
    const url = `/repos/${repo}/contents/${path}`;
    const res = await api.gh(url, { headers, cache: "no-store" });
    if (res.status === 304 && kept) {
      await keepPolicyFile(repo, { ...kept, checkedAt });
      return kept.outcome;
    }
    const read = await readRepoFileResponse(res, url);
    if (read === undefined) continue;
    const outcome = outcomeOf(read, repo, path);
    await keepPolicyFile(repo, { path, etag: res.headers.get("etag"), checkedAt, outcome });
    return outcome;
  }
  await keepPolicyFile(repo, { etag: null, checkedAt, outcome: { kind: "absent" } });
  return { kind: "absent" };
}

function fromFile({ policy, workflow, path, url }: Extract<FileOutcome, { kind: "policy" }>, repo: string): PolicyRead {
  if (policy.extends !== undefined) throw new Error("The policy file extends a shared policy only the hub holds, so it is not checked here.");
  return { pack: readCheckPack(policy, repo), workflow, path, url };
}

/** The repository's policy file, or null when it has none; a file that cannot be used throws why. */
export async function policyFor(api: GithubApi, repo: string, fresh: boolean): Promise<PolicyRead | null> {
  const file = await policyFile(api, repo, fresh);
  if (file.kind === "policy") return fromFile(file, repo);
  if (file.kind === "refused") throw new Error(file.reason);
  return null;
}
