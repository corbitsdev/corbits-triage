import { type } from "arktype";
import type { PrCommit } from "@corbits/github-reads";
import { isoTime, jsonAll, repoPath, type BitbucketFetch } from "./client.js";

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
