import { errorText } from "@corbits/common";
import { readRepoFileResponse, type RepoFileRead } from "@corbits/github-reads";
import { POLICY_FILE_PATH, readCheckPack, readPolicyFile, type CheckPack } from "@corbits/triage-contracts";
import type { GithubApi } from "./github-api.ts";
import { savedPackFor } from "./pack-store.ts";
import { keepPolicyFile, localPacks, policyFiles } from "./storage.ts";

// A file read within this long is used as read; after it, GitHub is asked whether it changed.
const REVALIDATE_MS = 10 * 60 * 1000;

type FileOutcome = { kind: "absent" } | { kind: "policy"; url: string; policy: Record<string, unknown> } | { kind: "refused"; reason: string };

export type KeptPolicyFile = { etag: string | null; checkedAt: string; outcome: FileOutcome };

export type PolicyOrigin = { from: "file"; url: string } | { from: "saved" } | { from: "default" };

export type PolicyRead = { pack: CheckPack; origin: PolicyOrigin };

function outcomeOf(read: RepoFileRead | undefined, repo: string): FileOutcome {
  if (read === undefined) return { kind: "absent" };
  if (read.kind === "not-a-file") return { kind: "refused", reason: `${POLICY_FILE_PATH} is not a file.` };
  if (read.text === null) return { kind: "refused", reason: `${POLICY_FILE_PATH} is too large.` };
  try {
    return { kind: "policy", url: read.url, policy: readPolicyFile(read.text, repo) };
  } catch (cause) {
    return { kind: "refused", reason: errorText(cause) };
  }
}

/** The file on the default branch, never a pull request's head, so a pull request cannot change the rules it is checked by. */
async function policyFile(api: GithubApi, repo: string, fresh: boolean): Promise<FileOutcome> {
  const kept = (await policyFiles.getValue())[repo];
  if (kept && !fresh && Date.now() - Date.parse(kept.checkedAt) < REVALIDATE_MS) return kept.outcome;
  const headers = new Headers({ accept: "application/vnd.github+json" });
  if (kept?.etag) headers.set("if-none-match", kept.etag);
  const url = `/repos/${repo}/contents/${POLICY_FILE_PATH}`;
  const res = await api.gh(url, { headers, cache: "no-store" });
  const checkedAt = new Date().toISOString();
  if (res.status === 304 && kept) {
    await keepPolicyFile(repo, { ...kept, checkedAt });
    return kept.outcome;
  }
  const outcome = outcomeOf(await readRepoFileResponse(res, url), repo);
  await keepPolicyFile(repo, { etag: res.headers.get("etag"), checkedAt, outcome });
  return outcome;
}

function fromFile(policy: Record<string, unknown>, url: string, repo: string): PolicyRead {
  if (policy.extends !== undefined) throw new Error(`${POLICY_FILE_PATH} extends a shared policy only the hub holds, so it is not checked here.`);
  return { pack: readCheckPack(policy, repo), origin: { from: "file", url } };
}

/** The repository's policy file first, then the rules saved in this browser, then the recommended rules; a file that cannot be used throws why. */
export async function policyFor(api: GithubApi, repo: string, fresh: boolean): Promise<PolicyRead> {
  const file = await policyFile(api, repo, fresh);
  if (file.kind === "policy") return fromFile(file.policy, file.url, repo);
  if (file.kind === "refused") throw new Error(file.reason);
  const saved = (await localPacks.getValue())[repo] !== undefined;
  return { pack: await savedPackFor(repo), origin: { from: saved ? "saved" : "default" } };
}
