import { type } from "arktype";
import { isoTime, json, jsonAll, PAGE_LIMIT, repoPath, type BitbucketFetch } from "./client.js";
import { authorAssociation, type Association } from "./people.js";
import { isBot, PullRequest } from "./shapes.js";

const Merge = type({ canMerge: "boolean", conflicted: "boolean", outcome: "string", vetoes: type({ summaryMessage: "string" }).array() });

const DiffStats = type({ filesChanged: "number", totalInsertions: "number", totalDeletions: "number" });

type Mergeability = { mergeable: boolean | null; canMerge?: boolean; mergeVetoes?: string[] };

/**
 * `mergeable` means free of conflicts, as on GitHub; whether Data Center's merge checks allow the merge is `canMerge`,
 * and `mergeVetoes` says why not. Data Center answers synchronously, so there is nothing to poll; an UNKNOWN outcome is null.
 */
export async function readMergeability(bb: BitbucketFetch, repo: string, number: number): Promise<Mergeability> {
  const merge = Merge.assert(await json(bb, `${repoPath(repo)}/pull-requests/${number}/merge`));
  const mergeable = merge.outcome === "UNKNOWN" ? null : !merge.conflicted;
  return { mergeable, canMerge: merge.canMerge, mergeVetoes: merge.vetoes.map((veto) => veto.summaryMessage) };
}

/** Totals for the whole pull request; instances older than the endpoint leave them out. */
async function diffStats(bb: BitbucketFetch, repo: string, number: number): Promise<{ additions?: number; deletions?: number; changedFiles?: number }> {
  const path = `${repoPath(repo)}/pull-requests/${number}/diff-stats-summary`;
  const res = await bb(path, { headers: { accept: "application/json" } });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`bitbucket GET ${path} -> ${res.status}`);
  const stats = DiffStats.assert(await res.json());
  return { additions: stats.totalInsertions, deletions: stats.totalDeletions, changedFiles: stats.filesChanged };
}

function prFields(pr: PullRequest, association: Association) {
  return {
    number: pr.id,
    title: pr.title,
    body: pr.description ?? null,
    state: pr.state === "OPEN" ? "open" : "closed",
    merged: pr.state === "MERGED",
    draft: pr.draft === true,
    author: pr.author.user.slug,
    authorAssociation: association,
    authorBot: isBot(pr.author.user),
    sha: pr.fromRef.latestCommit,
    branch: pr.fromRef.displayId,
    base: pr.toRef.displayId,
    requestedReviewers: pr.reviewers.length,
    reviewers: pr.reviewers.map((reviewer) => reviewer.user.slug),
    createdAt: isoTime(pr.createdDate),
    updatedAt: isoTime(pr.updatedDate),
    ...(pr.links?.self[0] && { url: pr.links.self[0].href }),
  };
}

/** The pull request's unified diff against its base. */
export async function readPrDiff(bb: BitbucketFetch, repo: string, number: number): Promise<string> {
  const path = `${repoPath(repo)}/pull-requests/${number}.diff`;
  const res = await bb(path, { headers: { accept: "text/plain" } });
  if (!res.ok) throw new Error(`bitbucket GET ${path} -> ${res.status}`);
  return res.text();
}

/** A closed pull request has no merge to check, so its mergeability is null. */
export async function getPr(bb: BitbucketFetch, repo: string, number: number) {
  const pr = PullRequest.assert(await json(bb, `${repoPath(repo)}/pull-requests/${number}`));
  const association = await authorAssociation(bb, repo, pr.author.user.slug);
  const merge: Mergeability = pr.state === "OPEN" ? await readMergeability(bb, repo, number) : { mergeable: null };
  return { ...prFields(pr, association), ...merge, ...(await diffStats(bb, repo, number)) };
}

function openPr(row: unknown) {
  const pr = PullRequest.assert(row);
  return {
    number: pr.id,
    title: pr.title,
    author: pr.author.user.slug,
    authorAssociation: null,
    authorBot: isBot(pr.author.user),
    draft: pr.draft === true,
    sha: pr.fromRef.latestCommit,
    // A fork's branch is not one of this repository's.
    branch: pr.fromRef.repository.id === pr.toRef.repository.id ? pr.fromRef.displayId : null,
    updatedAt: isoTime(pr.updatedDate),
    labels: [],
    url: pr.links?.self[0]?.href ?? null,
  };
}

/** `authorAssociation` costs up to three reads per author, so the listing leaves it null; `getPr` reads it. Only those into `base` when it is set. */
export async function listOpenPrs(bb: BitbucketFetch, repo: string, base?: string) {
  const into = base === undefined ? "" : `&direction=INCOMING&at=${encodeURIComponent(`refs/heads/${base}`)}`;
  return (await jsonAll(bb, `${repoPath(repo)}/pull-requests?state=OPEN${into}`)).map(openPr);
}

/** The pull requests merged into this one's branch, and the open one whose branch it is based on; a fork's branch is not stacked on this repository's. The newest page of each is enough to tell. */
export async function readStack(bb: BitbucketFetch, repo: string, number: number): Promise<{ includes: number[]; onto?: number }> {
  const pr = PullRequest.assert(await json(bb, `${repoPath(repo)}/pull-requests/${number}`));
  if (pr.fromRef.repository.id !== pr.toRef.repository.id) return { includes: [] };
  const [into, from] = await Promise.all([
    jsonAll(bb, `${repoPath(repo)}/pull-requests?state=MERGED&direction=INCOMING&at=${encodeURIComponent(pr.fromRef.id)}`, PAGE_LIMIT, 1),
    jsonAll(bb, `${repoPath(repo)}/pull-requests?state=OPEN&direction=OUTGOING&at=${encodeURIComponent(pr.toRef.id)}`, PAGE_LIMIT, 1),
  ]);
  const includes = into.map((row) => PullRequest.assert(row)).filter((merged) => merged.toRef.id === pr.fromRef.id).map((merged) => merged.id);
  const onto = from.map((row) => PullRequest.assert(row)).find((open) => open.id !== number && open.fromRef.id === pr.toRef.id)?.id;
  return onto === undefined ? { includes } : { includes, onto };
}
