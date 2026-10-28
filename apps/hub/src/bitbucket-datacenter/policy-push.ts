// The Bitbucket Data Center side of policy-push.ts: the policy file committed straight to the default branch as the
// connected account, where the branch's permissions let that account push.
import { type } from "arktype";
import { filePath, jsonAll, repoParts, repoPath, type BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { globMatch } from "@corbits/triage-workflows/logic/glob";
import type { PolicyPushAccess } from "@corbits/triage-contracts";
import { POLICY_PUSH_MESSAGE, type PolicyPush, type Pushed } from "../github/policy-push.js";
import { PolicyFileMoved } from "../github/policy-pull.js";
import { BitbucketFailed } from "./client.js";

const Restriction = type({
  type: "string",
  matcher: { id: "string", displayId: "string", type: { id: "string" } },
  "users?": type({ slug: "string" }).array(),
});
const Written = type({ id: "string" });

/** Restrictions that stop a commit pushed to the branch; `fast-forward-only` and `no-deletes` let one through. */
const REFUSING = new Set(["read-only", "pull-request-only"]);

/**
 * A branch matcher names one branch. A pattern is matched as a branch name and as a ref, and one using `?` is taken to
 * match, so a pattern read too narrowly never lets a push through; a branching model matcher is taken to match too.
 */
function applies(matcher: (typeof Restriction.infer)["matcher"], branch: string): boolean {
  if (matcher.type.id === "BRANCH") return matcher.id === `refs/heads/${branch}` || matcher.displayId === branch;
  if (matcher.type.id !== "PATTERN") return true;
  const pattern = matcher.id;
  return pattern.includes("?") || [branch, `refs/heads/${branch}`].some((name) => globMatch(name, pattern) || globMatch(name, `**/${pattern}`));
}

/** `user` is the slug the token acts as; an exemption for a group it may be in is not read, so it is not counted. */
export async function bitbucketPushAccess(bb: BitbucketFetch, repo: string, branch: string, user: string | undefined): Promise<PolicyPushAccess> {
  const { project, slug } = repoParts(repo);
  const path = `/rest/branch-permissions/2.0/projects/${project}/repos/${slug}/restrictions`;
  let rows: unknown[];
  try {
    rows = await jsonAll(bb, path);
  } catch (err) {
    // Reading them may need more than the account holds; unread, they are taken to refuse.
    if (!(err instanceof Error) || !/-> 40[134]\b/.test(err.message)) throw err;
    return { branch, allowed: false, reason: `Corbits Triage can't read the branch permissions on ${branch}, so changes reach it through a pull request.` };
  }
  const refusing = Restriction.array().assert(rows).filter((row) => REFUSING.has(row.type) && applies(row.matcher, branch) && !(user !== undefined && row.users?.some((each) => each.slug === user)));
  if (refusing.length > 0) return { branch, allowed: false, reason: `A branch permission on ${branch} (${[...new Set(refusing.map((row) => row.type))].join(", ")}) keeps Corbits Triage from pushing to it.` };
  return { branch, allowed: true };
}

/** `sha` is the commit that last changed the file, which Data Center takes as the edit's source and refuses with 409 once a later commit changed it. */
export async function pushBitbucketPolicy(bb: BitbucketFetch, repo: string, { branch, path, text, sha }: PolicyPush): Promise<Pushed> {
  const form = new FormData();
  // A file part keeps the text's line endings; a plain field would send them as CRLF.
  form.set("content", new Blob([text], { type: "text/plain" }), path);
  form.set("message", POLICY_PUSH_MESSAGE);
  form.set("branch", branch);
  form.set("sourceCommitId", sha);
  const written = `${repoPath(repo)}/browse/${filePath(path)}`;
  const res = await bb(written, { method: "PUT", body: form });
  if (res.status === 409) throw new PolicyFileMoved(path);
  if (!res.ok) throw new BitbucketFailed(res.status, written);
  const { id } = Written.assert(await res.json());
  // Data Center's file sha is the commit that last changed it, which is this one.
  return { sha: id, commit: id };
}
