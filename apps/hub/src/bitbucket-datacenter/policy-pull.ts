// The Bitbucket Data Center side of policy-pull.ts: one pull request from `corbits-triage/policy`, opened once and
// brought up to date when asked again.
import { type } from "arktype";
import { filePath, listPrCommits, readRepoFile, repoParts, repoPath, type BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { bodyWith, commitMessage, missingSections, openingBody, POLICY_BRANCH, PolicyFileMoved, replacedBody, retriedEdit, withCommitted, type PolicyChange, type PolicyPull } from "../github/policy-pull.js";
import { BitbucketFailed } from "./client.js";

const Pull = type({ id: "number", version: "number", title: "string", "description?": "string", fromRef: { latestCommit: "string" }, links: { self: type({ href: "string" }).array().atLeastLength(1) } });
const Pulls = type({ values: Pull.array() });
const Branches = type({ values: type({ displayId: "string" }).array() });
const Written = type({ id: "string" });

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

/** The sha the open pull request's branch is at, for a read of the branch's file. */
export async function openPolicyPullHead(bb: BitbucketFetch, repo: string): Promise<string | undefined> {
  return (await openPull(bb, repo))?.fromRef.latestCommit;
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

/**
 * Commits the file to the branch, making the branch from `base` when it is not there; the commit that last changed the
 * file is how Data Center refuses a stale edit. The commit made, undefined when the branch already held the text.
 */
async function commitFile(bb: BitbucketFetch, repo: string, base: string, onBranch: boolean, change: PolicyChange): Promise<string | undefined> {
  const { path, text, readSha } = change;
  const current = await readRepoFile(bb, repo, path, onBranch ? POLICY_BRANCH : base);
  if (onBranch && current?.kind === "file" && current.text === text) return undefined;
  if (readSha !== undefined && (current?.kind === "file" ? current.sha : null) !== readSha) throw new PolicyFileMoved(path);
  const form = new FormData();
  // A file part keeps the text's line endings; a plain field would send them as CRLF.
  form.set("content", new Blob([text], { type: "text/plain" }), path);
  form.set("message", commitMessage(change));
  form.set("branch", POLICY_BRANCH);
  if (!onBranch) form.set("sourceBranch", base);
  if (current?.kind === "file") form.set("sourceCommitId", current.sha);
  const written = `${repoPath(repo)}/browse/${filePath(path)}`;
  // Data Center refuses the edit with 409 when a commit has changed the file since `sourceCommitId`, or when a file
  // appeared where none was read.
  const res = await bb(written, { method: "PUT", body: form });
  if (res.status === 409 && readSha !== undefined) throw new PolicyFileMoved(path);
  if (!res.ok) throw new BitbucketFailed(res.status, written);
  return Written.assert(await res.json()).id;
}

/** Adds a section for each batch commit the description lacks, the new one included; with none lacking, no edit is made. */
async function appendSections(bb: BitbucketFetch, repo: string, id: number, change: PolicyChange, committed: string | undefined): Promise<void> {
  const path = `${repoPath(repo)}/pull-requests/${id}`;
  await retriedEdit(committed, async function appendMissing() {
    const latest = Pull.assert(await send(bb, path));
    // Data Center lists the newest commit first.
    const listed = (await listPrCommits(bb, repo, id)).toReversed();
    const commits = withCommitted(listed.map((row) => ({ commit: row.sha, message: row.message })), committed, change);
    const added = missingSections(latest.description, commits, change.title);
    if (added.length === 0) return;
    await send(bb, path, { method: "PUT", body: JSON.stringify({ version: latest.version, title: latest.title, description: bodyWith(latest.description, added) }) });
  });
}

export async function proposePolicy(bb: BitbucketFetch, repo: string, base: string, change: PolicyChange): Promise<PolicyPull> {
  const open = await openPull(bb, repo);
  const left = !open && (await branchExists(bb, repo));
  if (left) await deleteBranch(bb, repo);
  const committed = await commitFile(bb, repo, base, Boolean(open), change);
  if (!open) return createPull(bb, repo, base, change, committed);
  if (change.append) {
    await appendSections(bb, repo, open.id, change, committed);
    return pullOf(open);
  }
  await send(bb, `${repoPath(repo)}/pull-requests/${open.id}`, { method: "PUT", body: JSON.stringify({ version: open.version, title: change.title, description: replacedBody(open.description, change, committed) }) });
  return pullOf(open);
}

/** A pull request opened by a concurrent call in between is answered instead of refused. */
async function createPull(bb: BitbucketFetch, repo: string, base: string, change: PolicyChange, committed: string | undefined): Promise<PolicyPull> {
  const path = `${repoPath(repo)}/pull-requests`;
  const res = await bb(path, { method: "POST", body: JSON.stringify({ title: change.title, description: openingBody(change, committed), fromRef: { id: BRANCH_REF }, toRef: { id: `refs/heads/${base}` } }) });
  if (res.ok) return pullOf(Pull.assert(await res.json()));
  const raced = res.status === 409 ? await openPull(bb, repo) : undefined;
  if (raced) return pullOf(raced);
  throw new BitbucketFailed(res.status, path);
}
