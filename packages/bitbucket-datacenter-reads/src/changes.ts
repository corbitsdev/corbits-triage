import { type } from "arktype";
import { PR_FILES_PAGE_CHARS, type PrCommit, type PrFilesPage } from "@corbits/github-reads";
import type { HeadChange } from "@corbits/triage-contracts";
import { isoTime, jsonAll, PAGE_LIMIT, repoPath, type BitbucketFetch } from "./client.js";

/** Line counts per file would cost a diff read per file, so only the pull request's totals carry them. */
export type PrChange = { path: string; previousPath?: string; status: string };

const Path = type({ toString: "string" });

const Change = type({ path: Path, "srcPath?": Path, type: "string" });

const STATUSES: Record<string, string> = { ADD: "added", DELETE: "removed", MODIFY: "modified", MOVE: "renamed", COPY: "copied" };

function prChange(row: unknown): PrChange {
  const change = Change.assert(row);
  const status = STATUSES[change.type];
  if (status === undefined) throw new Error(`bitbucket change ${change.path.toString} has an unknown type ${change.type}`);
  return { path: change.path.toString, status, ...(change.srcPath === undefined ? {} : { previousPath: change.srcPath.toString }) };
}

export async function listPrFiles(bb: BitbucketFetch, repo: string, number: number): Promise<PrChange[]> {
  return (await jsonAll(bb, `${repoPath(repo)}/pull-requests/${number}/changes`)).map(prChange);
}

/** One page of the changed files from `offset`, under the tool-result cap; Data Center's change list carries no patch. */
export async function listPrFilesPage(bb: BitbucketFetch, repo: string, number: number, offset = 0): Promise<PrFilesPage> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`invalid file offset ${offset}`);
  const changes = await listPrFiles(bb, repo, number);
  const page: PrFilesPage = { files: [] };
  let index = offset;
  for (; index < changes.length; index++) {
    const file = { ...changes[index]!, additions: 0, deletions: 0 };
    if (JSON.stringify({ files: [...page.files, file], next: Number.MAX_SAFE_INTEGER }).length > PR_FILES_PAGE_CHARS && page.files.length > 0) break;
    page.files.push(file);
  }
  if (index < changes.length) page.next = index;
  return page;
}

const Person = type({ name: "string", "slug?": "string" });

const Commit = type({ id: "string", message: "string", author: Person, committerTimestamp: "number" });

/** A commit author matched to a Data Center user carries its slug; otherwise the git author name stands, as on GitHub. */
function prCommit(row: unknown): PrCommit {
  const commit = Commit.assert(row);
  return { sha: commit.id, message: commit.message, author: commit.author.slug ?? commit.author.name, committedAt: isoTime(commit.committerTimestamp) };
}

export async function listPrCommits(bb: BitbucketFetch, repo: string, number: number): Promise<PrCommit[]> {
  return (await jsonAll(bb, `${repoPath(repo)}/pull-requests/${number}/commits`)).map(prCommit);
}

/** The default branch's commits that changed `path` since `since`, newest first: one page, which a recent window fills only on the busiest file. */
export async function listPathCommits(bb: BitbucketFetch, repo: string, path: string, since: string): Promise<PrCommit[]> {
  const after = Date.parse(since);
  if (Number.isNaN(after)) throw new Error(`invalid since ${since}`);
  const rows = (await jsonAll(bb, `${repoPath(repo)}/commits?path=${encodeURIComponent(path)}`, PAGE_LIMIT, 1)).map(prCommit);
  return rows.filter((commit) => Date.parse(commit.committedAt) >= after);
}

const MergedPr = type({ id: "number", "properties?": { "mergeCommit?": { id: "string" } } });

/**
 * The commits from `from` to `to`, and the pull requests merged into `branch`, a ref id, whose merge commit is one of
 * them; a branch in a fork has none here. Only the newest page of merged pull requests is read, so an older merge is
 * not named. Undefined when the instance no longer has `from`, such as after a force-push.
 */
export async function changesSince(bb: BitbucketFetch, repo: string, branch: string | undefined, from: string, to: string): Promise<HeadChange | undefined> {
  const earlier = `${repoPath(repo)}/commits/${encodeURIComponent(from)}`;
  const res = await bb(earlier, { headers: { accept: "application/json" } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`bitbucket GET ${earlier} -> ${res.status}`);
  const commits = await jsonAll(bb, `${repoPath(repo)}/commits?since=${encodeURIComponent(from)}&until=${encodeURIComponent(to)}`);
  if (branch === undefined) return { commits: commits.length, merged: [] };
  const shas = new Set(commits.map((row) => Commit.assert(row).id));
  const into = (await jsonAll(bb, `${repoPath(repo)}/pull-requests?state=MERGED&direction=INCOMING&at=${encodeURIComponent(branch)}`, PAGE_LIMIT, 1)).map((row) => MergedPr.assert(row));
  const merged = into.filter((pr) => pr.properties?.mergeCommit !== undefined && shas.has(pr.properties.mergeCommit.id));
  return { commits: commits.length, merged: merged.map((pr) => pr.id).sort((a, b) => a - b) };
}
