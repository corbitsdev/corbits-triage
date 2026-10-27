// Writing a repository's policy file straight to its default branch as the App, one commit, where the branch lets the
// App push without a pull request.
import { type } from "arktype";
import { json, jsonAll, requestError, type GithubFetch } from "@corbits/github-reads";
import type { PolicyPushAccess } from "@corbits/triage-contracts";
import { PolicyFileMoved } from "./policy-pull.js";

export const POLICY_PUSH_MESSAGE = "chore: update the Corbits Triage policy";

/** `sha` is the blob the change was made from; the commit is refused when the file on the branch is no longer it. */
export type PolicyPush = { branch: string; path: string; text: string; sha: string };

/** The file's sha after the push, as the next read of it answers, and the commit that made it. */
export type Pushed = { sha: string; commit: string };

const Branch = type({ protected: "boolean" });
const Rule = type({ type: "string" });
const Written = type({ content: { sha: "string" }, commit: { sha: "string" } });

/**
 * Ruleset rules a single commit made through the contents API passes: the App's commits are signed and fast-forward,
 * and none of these look at what a commit changes. Any other rule, a required pull request or status check included,
 * may refuse it, so it is taken to.
 */
const PASSABLE_RULES = new Set(["creation", "deletion", "non_fast_forward", "required_linear_history", "required_signatures", "branch_name_pattern", "tag_name_pattern"]);

/**
 * Classic branch protection's details need the administration permission the App does not ask for, so a protected
 * branch is taken to refuse the App; rulesets are read as the rules that apply to the branch.
 */
export async function githubPushAccess(gh: GithubFetch, repo: string): Promise<PolicyPushAccess> {
  const { default_branch: branch } = await json(gh, `/repos/${repo}`);
  const at = encodeURIComponent(branch);
  if (Branch.assert(await json(gh, `/repos/${repo}/branches/${at}`)).protected) return { branch, allowed: false, reason: `${branch} is a protected branch, so changes reach it through a pull request.` };
  const rules = Rule.array().assert(await jsonAll(gh, `/repos/${repo}/rules/branches/${at}?per_page=100`));
  const refusing = [...new Set(rules.map((rule) => rule.type).filter((kind) => !PASSABLE_RULES.has(kind)))];
  if (refusing.length > 0) return { branch, allowed: false, reason: `A ruleset on ${branch} applies ${refusing.join(", ")}, so changes reach it through a pull request.` };
  return { branch, allowed: true };
}

/** GitHub answers 409 both for a file that moved off `sha` and for a ruleset that refused the commit. */
export async function pushGithubPolicy(gh: GithubFetch, repo: string, { branch, path, text, sha }: PolicyPush): Promise<Pushed> {
  const url = `/repos/${repo}/contents/${path}`;
  const res = await gh(url, { method: "PUT", body: JSON.stringify({ message: POLICY_PUSH_MESSAGE, content: Buffer.from(text, "utf8").toString("base64"), branch, sha }) });
  if (res.ok) {
    const written = Written.assert(await res.json());
    return { sha: written.content.sha, commit: written.commit.sha };
  }
  const refused = await requestError(res, "PUT", url);
  if (res.status === 409 && !/\brule/i.test(refused.message)) throw new PolicyFileMoved(path);
  throw refused;
}
