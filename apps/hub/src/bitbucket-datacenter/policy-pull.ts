// The Bitbucket Data Center side of policy-pull.ts: one pull request from `corbits-triage/policy`, opened once and
// brought up to date when asked again.
import { type } from "arktype";
import { filePath, readRepoFile, repoParts, repoPath, type BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { POLICY_BRANCH, type PolicyChange, type PolicyPull } from "../github/policy-pull.js";
import { BitbucketFailed } from "./client.js";

const Pull = type({ id: "number", version: "number", links: { self: type({ href: "string" }).array().atLeastLength(1) } });
const Pulls = type({ values: Pull.array() });
const Branches = type({ values: type({ displayId: "string" }).array() });

const BRANCH_REF = `refs/heads/${POLICY_BRANCH}`;

function pullOf(pull: typeof Pull.infer): PolicyPull {
  return { url: pull.links.self[0]!.href, number: pull.id };
}

async function send(bb: BitbucketFetch, path: string, init?: RequestInit): Promise<unknown> {
  const res = await bb(path, init);
  if (!res.ok) throw new BitbucketFailed(res.status, path);
  return res.status === 204 ? null : res.json();
}

async function openPull(bb: BitbucketFetch, repo: string): Promise<typeof Pull.infer | undefined> {
  const path = `${repoPath(repo)}/pull-requests?state=OPEN&direction=OUTGOING&at=${encodeURIComponent(BRANCH_REF)}`;
  return Pulls.assert(await send(bb, path)).values[0];
}

export async function openPolicyPull(bb: BitbucketFetch, repo: string): Promise<PolicyPull | undefined> {
  const pull = await openPull(bb, repo);
  return pull && pullOf(pull);
}

async function branchExists(bb: BitbucketFetch, repo: string): Promise<boolean> {
  const path = `${repoPath(repo)}/branches?filterText=${encodeURIComponent(POLICY_BRANCH)}&limit=100`;
  return Branches.assert(await send(bb, path)).values.some((row) => row.displayId === POLICY_BRANCH);
}

/** A branch left from an earlier pull request starts over from the default branch, as on GitHub. Unverified against a live instance. */
async function deleteBranch(bb: BitbucketFetch, repo: string): Promise<void> {
  const { project, slug } = repoParts(repo);
  await send(bb, `/rest/branch-utils/1.0/projects/${project}/repos/${slug}/branches`, { method: "DELETE", body: JSON.stringify({ name: BRANCH_REF, dryRun: false }) });
}

/** Commits the file to the branch, making the branch from `base` when it is not there; the commit that last changed the file is how Data Center refuses a stale edit. */
async function commitFile(bb: BitbucketFetch, repo: string, base: string, onBranch: boolean, { path, text, title }: PolicyChange): Promise<void> {
  const current = await readRepoFile(bb, repo, path, onBranch ? POLICY_BRANCH : base);
  if (onBranch && current?.kind === "file" && current.text === text) return;
  const form = new FormData();
  // A file part keeps the text's line endings; a plain field would send them as CRLF.
  form.set("content", new Blob([text], { type: "text/plain" }), path);
  form.set("message", title);
  form.set("branch", POLICY_BRANCH);
  if (!onBranch) form.set("sourceBranch", base);
  if (current?.kind === "file") form.set("sourceCommitId", current.sha);
  await send(bb, `${repoPath(repo)}/browse/${filePath(path)}`, { method: "PUT", body: form });
}

export async function proposePolicy(bb: BitbucketFetch, repo: string, base: string, change: PolicyChange): Promise<PolicyPull> {
  const open = await openPull(bb, repo);
  const left = !open && (await branchExists(bb, repo));
  if (left) await deleteBranch(bb, repo);
  await commitFile(bb, repo, base, Boolean(open), change);
  const pulls = `${repoPath(repo)}/pull-requests`;
  if (open) {
    await send(bb, `${pulls}/${open.id}`, { method: "PUT", body: JSON.stringify({ version: open.version, title: change.title, description: change.body }) });
    return pullOf(open);
  }
  return createPull(bb, repo, base, change);
}

/** A pull request opened by a concurrent call in between is answered instead of refused. */
async function createPull(bb: BitbucketFetch, repo: string, base: string, { title, body }: PolicyChange): Promise<PolicyPull> {
  const path = `${repoPath(repo)}/pull-requests`;
  const res = await bb(path, { method: "POST", body: JSON.stringify({ title, description: body, fromRef: { id: BRANCH_REF }, toRef: { id: `refs/heads/${base}` } }) });
  if (res.ok) return pullOf(Pull.assert(await res.json()));
  const raced = res.status === 409 ? await openPull(bb, repo) : undefined;
  if (raced) return pullOf(raced);
  throw new BitbucketFailed(res.status, path);
}
