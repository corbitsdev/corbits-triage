import { type } from "arktype";
import { minimatch } from "minimatch";
import { asRecord, compare, errorText } from "@corbits/common";
import { parseFindingHeadline, threadsHold, threadsUnread } from "@corbits/triage-contracts/code-review";
import { contributionRuleRank, isDocPath } from "@corbits/triage-contracts/paths";
import { teamSlug } from "@corbits/triage-contracts/team";

/** Pinned to the GitHub API origin. */
export type GithubFetch = (path: string, init?: RequestInit) => Promise<Response>;

export const INSTALLATION_SELECTOR_HEADER = "x-corbits-github-installation-id";

export const TRIAGE_COMMENT_MARKER = "<!-- corbits-triage -->";
// Also matches the earlier per-head `<!-- corbits-triage:repo#n@sha -->` marker, so those comments are edited rather than duplicated.
const TRIAGE_COMMENT_PREFIX = "<!-- corbits-triage";

export function isTriageComment(body: string): boolean {
  return body.startsWith(TRIAGE_COMMENT_PREFIX);
}

function detailText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  const message = asRecord(entry)?.["message"];
  return typeof message === "string" ? message : "";
}

/**
 * GitHub's reason for a refusal, such as the review a ruleset requires; empty when the body gives none. A 422 says only
 * "Unprocessable Entity" in `message` and the reason in `errors`.
 */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json() as { message?: unknown; errors?: unknown };
    const details = Array.isArray(body.errors) ? body.errors.map(detailText).filter(Boolean) : [];
    if (details.length) return details.join("; ");
    return typeof body.message === "string" ? body.message : "";
  } catch {
    return "";
  }
}

async function request(gh: GithubFetch, path: string, init?: RequestInit): Promise<Response> {
  const res = await gh(path, {
    ...init,
    headers: { accept: "application/vnd.github+json", ...init?.headers },
  });
  if (!res.ok) throw await requestError(res, init?.method ?? "GET", path);
  return res;
}

/** The error a refused GitHub request throws, carrying its status and GitHub's reason; for a caller that sent the request itself. */
export async function requestError(res: Response, method: string, path: string): Promise<Error> {
  return new Error(`github ${method} ${path} -> ${res.status} ${await errorMessage(res)}`.trimEnd());
}

export async function json(gh: GithubFetch, path: string, init?: RequestInit): Promise<any> {
  const res = await request(gh, path, init);
  return res.status === 204 ? null : res.json();
}

const SHA = /^[0-9a-f]{40}$/;

const NEXT_LINK = /<([^>]+)>;\s*rel="next"/;

type PageOptions<T> = { init?: RequestInit; items?: (page: unknown) => T[] };

export async function jsonAll<T = unknown>(gh: GithubFetch, path: string, { init, items = (page) => page as T[] }: PageOptions<T> = {}): Promise<T[]> {
  const { pathname } = new URL(path, "https://github.invalid");
  const rows: T[] = [];
  const requested = new Set([path]);
  let next: string | undefined = path;
  while (next) {
    const res = await request(gh, next, init);
    const page = items(await res.json());
    if (!Array.isArray(page)) throw new Error(`github returned an invalid page for ${path}`);
    rows.push(...page);
    const link = NEXT_LINK.exec(res.headers.get("link") ?? "")?.[1];
    next = link ? pathname + new URL(link).search : undefined;
    if (next && requested.has(next)) throw new Error(`github pagination for ${path} repeated ${next}`);
    if (next) requested.add(next);
  }
  return rows;
}

// Enterprise accounts carry a slug instead of a login.
const Installation = type({
  id: "number.integer > 0",
  account: type({ "login?": "string", "slug?": "string" }).or("null"),
  html_url: "string",
  repository_selection: "'all' | 'selected'",
  suspended_at: "string | null",
});

export type GithubInstallation = {
  id: number;
  account: string | undefined;
  htmlUrl: string;
  selection: "all" | "selected";
  suspended: boolean;
};

export async function listInstallations(gh: GithubFetch): Promise<GithubInstallation[]> {
  const rows = Installation.array().assert(await jsonAll(gh, "/app/installations?per_page=100"));
  return rows.map((row) => ({
    id: row.id,
    account: row.account?.login ?? row.account?.slug,
    htmlUrl: row.html_url,
    selection: row.repository_selection,
    suspended: row.suspended_at !== null,
  }));
}

export async function listInstallationRepositories(gh: GithubFetch, installationId: number): Promise<string[]> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error("installationId must be a positive integer");
  const repositories = await jsonAll(gh, "/installation/repositories?per_page=100", {
    init: { headers: { [INSTALLATION_SELECTOR_HEADER]: String(installationId) } },
    items: (page) => (page as { repositories?: Array<{ full_name?: unknown }> } | null)?.repositories as Array<{ full_name?: unknown }>,
  });
  return repositories.map((repository) => {
    if (typeof repository.full_name !== "string" || !repository.full_name) throw new Error("github returned an invalid repository");
    return repository.full_name;
  });
}

export async function listOpenPrs(gh: GithubFetch, repo: string) {
  const prs = await jsonAll<any>(gh, `/repos/${repo}/pulls?state=open&per_page=100`);
  return prs.map((p: any) => ({
    number: p.number,
    title: p.title,
    author: p.user?.login ?? null,
    authorAssociation: p.author_association ?? null,
    authorBot: p.user?.type === "Bot",
    draft: p.draft,
    sha: p.head?.sha,
    // A fork's branch is not one of this repository's.
    branch: p.head?.repo?.id !== undefined && p.head.repo.id === p.base?.repo?.id ? (p.head.ref as string) : null,
    updatedAt: p.updated_at,
    labels: p.labels?.map((l: any) => l.name) ?? [],
    url: typeof p.html_url === "string" ? p.html_url : null,
  }));
}

const OpenInto = type({ number: "number", title: "string", draft: "boolean", head: { sha: "string" } });

/** The open pull requests into `base`, with only what comparing them with another needs. */
export async function listOpenPrsInto(gh: GithubFetch, repo: string, base: string): Promise<Array<{ number: number; title: string; draft: boolean; sha: string }>> {
  const rows = OpenInto.array().assert(await jsonAll(gh, `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`));
  return rows.map((row) => ({ number: row.number, title: row.title, draft: row.draft, sha: row.head.sha }));
}

/** A stacked branch: the pull requests merged into it, and the open pull request whose branch it is based on. */
export type Stack = { includes: number[]; onto?: number };

/** A fork's branch is not one of this repository's, so nothing here is stacked on it. The newest page of each is enough to tell, even for a long-lived branch with thousands. */
export async function readStack(gh: GithubFetch, repo: string, number: number): Promise<Stack> {
  const pr = await json(gh, `/repos/${repo}/pulls/${number}`);
  if (pr.head?.repo?.id === undefined || pr.head.repo.id !== pr.base?.repo?.id) return { includes: [] };
  const head: string = pr.head.ref;
  const base: string = pr.base.ref;
  const owner = repo.split("/")[0];
  const [into, from] = await Promise.all([
    json(gh, `/repos/${repo}/pulls?state=closed&base=${encodeURIComponent(head)}&per_page=100`),
    json(gh, `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${base}`)}&per_page=100`),
  ]);
  const includes = into.filter((p: any) => typeof p.merged_at === "string" && p.base?.ref === head).map((p: any) => p.number as number);
  const onto = from.find((p: any) => p.number !== number && p.head?.ref === base && p.head?.repo?.id === pr.base.repo.id)?.number;
  return onto === undefined ? { includes } : { includes, onto };
}

const CLOSED_PRS_PER_PAGE = 100;

export type ClosedPr = { number: number; merged: boolean; closedAt: string };

/** One page of closed pull requests, most recently updated first; `next` is the following page when this one was full. */
export async function listClosedPrsPage(gh: GithubFetch, repo: string, page: number): Promise<{ prs: ClosedPr[]; next?: number }> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error(`invalid page ${page}`);
  const rows = await json(gh, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${CLOSED_PRS_PER_PAGE}&page=${page}`);
  if (!Array.isArray(rows)) throw new Error(`github returned an invalid closed pull request page for ${repo}`);
  const prs = rows.map((p: any) => ({ number: p.number, merged: p.merged_at !== null, closedAt: p.closed_at }));
  return rows.length === CLOSED_PRS_PER_PAGE ? { prs, next: page + 1 } : { prs };
}

type GithubRepoOwner = { login?: unknown; type?: unknown };

export async function listOrgMembersForRepo(gh: GithubFetch, repo: string): Promise<{ organization: string; members: string[] }> {
  const repository = await json(gh, `/repos/${repo}`) as { owner?: GithubRepoOwner };
  const owner = repository.owner;
  if (owner?.type !== "Organization" || typeof owner.login !== "string" || owner.login.length === 0) {
    throw new Error(`${repo} is not owned by a GitHub organization`);
  }

  const rows = await jsonAll<{ login?: unknown }>(gh, `/orgs/${encodeURIComponent(owner.login)}/members?per_page=100`);
  const members = rows.flatMap((row) => typeof row.login === "string" && row.login.length > 0 ? [row.login] : []);
  return { organization: owner.login, members: [...new Set(members)].sort((a, b) => a.localeCompare(b)) };
}

export const MAX_AUTHOR_TEAMS = 20;

export type AuthorTeams = { teams: string[]; unknown: string[] };

export type Membership = "member" | "not" | "unknown";

/** A value put in one path segment; `.` and `..` move the path even when encoded. */
function segment(value: string): string {
  if (value === "" || value === "." || value === "..") throw new Error(`"${value}" cannot name a path segment`);
  return encodeURIComponent(value);
}

/** A 404 hides both a non-member and a team the App cannot see, so the team itself is read to tell them apart. */
async function membership(gh: GithubFetch, org: string, slug: string, author: string): Promise<Membership> {
  const team = `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`;
  const headers = { accept: "application/vnd.github+json" };
  const res = await gh(`${team}/memberships/${segment(author)}`, { headers });
  if (res.ok) return (await res.json() as { state?: unknown }).state === "active" ? "member" : "not";
  if (res.status !== 404) return "unknown";
  const found = await gh(team, { headers });
  return found.ok ? "not" : "unknown";
}

/** Which of `teams` the author actively belongs to. Teams past the first MAX_AUTHOR_TEAMS, in another org, in a repository no org owns, or whose membership GitHub will not show are unknown. */
export async function authorTeams(gh: GithubFetch, input: { repo: string; author: string; teams: string[] }): Promise<AuthorTeams> {
  const org = input.repo.split("/", 1)[0]!;
  return teamsOfAuthor(input, (slug) => membership(gh, org, slug, input.author));
}

/** Sorts `teams` into those the author belongs to and those unknown, asking `membershipOf` once per team slug. */
export async function teamsOfAuthor(input: { repo: string; teams: string[] }, membershipOf: (slug: string) => Promise<Membership>): Promise<AuthorTeams> {
  const result: AuthorTeams = { teams: [], unknown: input.teams.slice(MAX_AUTHOR_TEAMS) };
  for (const team of input.teams.slice(0, MAX_AUTHOR_TEAMS)) {
    const slug = teamSlug(team, input.repo);
    const answer = slug === null ? "unknown" : await membershipOf(slug);
    if (answer === "member") result.teams.push(team);
    else if (answer === "unknown") result.unknown.push(team);
  }
  return result;
}

const MERGEABLE_RETRIES = 5;
const MERGEABLE_BACKOFF_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The full media type adds `body_html`, GitHub's own rendering of the body, without what its markdown hides.
function pullRequest(gh: GithubFetch, repo: string, number: number): Promise<any> {
  return json(gh, `/repos/${repo}/pulls/${number}`, { headers: { accept: "application/vnd.github.full+json" } });
}

function prFields(p: any) {
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    bodyHtml: p.body_html,
    state: p.state,
    merged: p.merged,
    draft: p.draft,
    author: p.user?.login ?? null,
    authorAssociation: p.author_association ?? null,
    authorBot: p.user?.type === "Bot",
    sha: p.head?.sha,
    branch: p.head?.ref,
    base: p.base?.ref,
    mergeable: p.mergeable,
    mergeableState: p.mergeable_state,
    requestedReviewers: (p.requested_reviewers?.length ?? 0) + (p.requested_teams?.length ?? 0),
    reviewers: [...(p.requested_reviewers ?? []).map((u: any) => u.login), ...(p.requested_teams ?? []).map((t: any) => t.slug)],
    assignees: (p.assignees ?? []).map((u: { login: string }) => u.login),
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changed_files,
    labels: p.labels?.map((l: any) => l.name) ?? [],
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/** Without waiting for mergeability. */
export async function readPr(gh: GithubFetch, repo: string, number: number) {
  return prFields(await pullRequest(gh, repo, number));
}

function fileDiff({ path, previousPath, patch }: PrFile): string {
  return `diff --git a/${previousPath ?? path} b/${path}\n--- a/${previousPath ?? path}\n+++ b/${path}\n${patch ?? ""}\n`;
}

/** The pull request's unified diff against its base; GitHub refuses the diff of a very large pull request, which is then built from its files' patches. */
export async function readPrDiff(gh: GithubFetch, repo: string, number: number): Promise<string> {
  const path = `/repos/${repo}/pulls/${number}`;
  const res = await gh(path, { headers: { accept: "application/vnd.github.diff" } });
  if (res.status === 406) return (await listPrFiles(gh, repo, number)).map(fileDiff).join("");
  if (!res.ok) throw new Error(`github GET ${path} -> ${res.status}`);
  return res.text();
}

/** GitHub computes mergeability lazily; `mergeable: null` means poll again. */
export async function getPr(gh: GithubFetch, repo: string, number: number) {
  let p = await pullRequest(gh, repo, number);
  for (let i = 0; i < MERGEABLE_RETRIES && p.mergeable === null && p.state === "open"; i++) {
    await sleep(MERGEABLE_BACKOFF_MS);
    p = await pullRequest(gh, repo, number);
  }
  return prFields(p);
}

export interface CheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

interface CheckRunRow {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
}

// A run not started yet is the newest, so a queued re-run keeps CI pending.
function startedAt(run: CheckRunRow): string {
  return run.started_at ?? "￿";
}

function newer(a: CheckRunRow, b: CheckRunRow): boolean {
  if (startedAt(a) === startedAt(b)) return a.id > b.id;
  return startedAt(a) > startedAt(b);
}

/** Re-runs of a check share its name across suites; only the latest counts, as on GitHub's merge box. */
function latestPerName(runs: CheckRunRow[]): CheckRunRow[] {
  const latest = new Map<string, CheckRunRow>();
  for (const run of runs) {
    const kept = latest.get(run.name);
    if (kept === undefined || newer(run, kept)) latest.set(run.name, run);
  }
  return [...latest.values()];
}

async function latestCheckRuns(gh: GithubFetch, repo: string, sha: string): Promise<CheckRunRow[]> {
  if (!SHA.test(sha)) throw new Error(`sha must be 40 hex characters, got ${sha}`);
  const runs = await jsonAll<CheckRunRow>(gh, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`, { items: (page) => (page as { check_runs: CheckRunRow[] }).check_runs });
  return latestPerName(runs);
}

export async function getChecks(gh: GithubFetch, repo: string, sha: string): Promise<CheckRun[]> {
  return (await latestCheckRuns(gh, repo, sha)).map((c) => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
  }));
}

const FAILED = new Set(["failure", "timed_out", "action_required"]);
// A cancelled or stale run ended without a result: neither failed nor still running, it waits on a re-run.
const CANCELLED = new Set(["cancelled", "stale"]);

export function checkFailed(run: CheckRun): boolean {
  return run.conclusion !== undefined && run.conclusion !== null && FAILED.has(run.conclusion);
}

export function checkPending(run: CheckRun): boolean {
  return run.status !== "completed";
}

export function checkCancelled(run: CheckRun): boolean {
  return run.status === "completed" && CANCELLED.has(run.conclusion ?? "");
}

export type CiState = "success" | "failure" | "pending" | "cancelled" | "none";

export function summarizeChecks(runs: CheckRun[]): CiState {
  if (!runs.length) return "none";
  if (runs.some(checkFailed)) return "failure";
  if (runs.some(checkPending)) return "pending";
  if (runs.some(checkCancelled)) return "cancelled";
  return "success";
}

/** A head may merge once its CI passed, or with no CI at all when the policy does not require it. */
export function mergeableCi(ci: CiState, ciOptional: boolean): boolean {
  return ci === "success" || (ci === "none" && ciOptional);
}

const CI_TEXT: Record<CiState, string> = {
  success: "CI passed on this head",
  failure: "CI has failed on this head",
  pending: "CI has not finished on this head",
  cancelled: "CI was cancelled on this head",
  none: "There is no CI on this head",
};

export function ciRefusal(ci: CiState): string {
  return CI_TEXT[ci];
}

/** Each reviewer's latest decisive review state; triage's own requests for changes are its verdict, not a reviewer's. */
export function latestDecisive(reviews: Review[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.reviewer && r.state && r.state !== "COMMENTED" && r.state !== "PENDING" && !r.triageRequest) latest.set(r.reviewer, r.state);
  }
  return latest;
}

function carries(review: any, marker: string): boolean {
  return typeof review.body === "string" && review.body.includes(marker);
}

/**
 * `login` names the App's bot account, as only the App's marked reviews are triage's own; without it, as with a job
 * token, a marked review from any App account is.
 */
export async function getReviews(gh: GithubFetch, repo: string, number: number, login?: string): Promise<Review[]> {
  const reviews = await jsonAll<any>(gh, `/repos/${repo}/pulls/${number}/reviews?per_page=100`);
  function reviewOf(v: any): Review {
    const own = login === undefined ? v.user?.type === "Bot" : v.user?.login === login;
    return {
      reviewer: v.user?.login,
      state: v.state,
      submittedAt: v.submitted_at,
      commitId: v.commit_id,
      ...(own && carries(v, REQUEST_CHANGES_DO_MARKER) ? { triageRequest: true as const } : {}),
      ...(own && carries(v, CODE_REVIEW_MARKER) ? { codeReview: true as const } : {}),
    };
  }
  return reviews.map(reviewOf);
}

/**
 * `triageRequest` marks the request-changes Do's own review, which is triage's verdict rather than a reviewer's;
 * `codeReview` marks a code review sent to the pull request.
 */
export type Review = { reviewer?: string; state?: string; submittedAt?: string; commitId?: string; triageRequest?: true; codeReview?: true };

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

const MERGEABLE = { MERGEABLE: true, CONFLICTING: false, UNKNOWN: null } as const;

const MergeStateNode = type({ number: "number", state: "'OPEN' | 'CLOSED' | 'MERGED'", mergeable: "'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'", mergeStateStatus: "string", reviewDecision: "'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null" });

const MergeStatesReply = type({ data: { repository: { "[string]": MergeStateNode.or("null") } }, "errors?": type({ "path?": "(string | number)[]" }).array() });

/** `mergeableState` is REST's `mergeable_state`; `reviewDecision` is null when no review is required. */
export type MergeState = { number: number; open: boolean; mergeable: boolean | null; mergeableState: string; reviewDecision: ReviewDecision | null };

/**
 * Whether GitHub would merge each pull request now and whether the branch's rules still want a review, which only GraphQL says, all in one query.
 * A pull request GitHub answers null or with an error is left out; an error that names no pull request leaves them all out.
 */
export async function readMergeStates(gh: GithubFetch, repo: string, numbers: readonly number[]): Promise<MergeState[]> {
  const [owner, name] = repo.split("/");
  const pulls = numbers.map((number) => `pr${number}: pullRequest(number: ${number}) { number state mergeable mergeStateStatus reviewDecision }`).join(" ");
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${pulls} } }`;
  const reply = await json(gh, "/graphql", { method: "POST", body: JSON.stringify({ query, variables: { owner, name } }), headers: { "content-type": "application/json" } });
  const { data, errors = [] } = MergeStatesReply.assert(reply);
  if (errors.some((error) => typeof error.path?.[1] !== "string")) return [];
  const failed = new Set(errors.map((error) => error.path?.[1]));
  return Object.entries(data.repository).flatMap(([alias, node]) => (node === null || failed.has(alias) ? [] : [{ number: node.number, open: node.state === "OPEN", mergeable: MERGEABLE[node.mergeable], mergeableState: node.mergeStateStatus.toLowerCase(), reviewDecision: node.reviewDecision }]));
}

const ThreadComment = type({ databaseId: "number", createdAt: "string", author: type({ login: "string" }).or("null"), "pullRequestReview?": type({ databaseId: "number" }).or("null") });
const ThreadsReply = type({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: "boolean", endCursor: "string | null" },
          nodes: type({ isResolved: "boolean", isOutdated: "boolean", opener: { nodes: ThreadComment.array() }, comments: { nodes: ThreadComment.array() } }).array(),
        },
      },
    },
  },
});
export type ReviewThread = (typeof ThreadsReply.infer)["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][number];

// A thread's state needs only the comment that opened it and its newest reply, so the newest page of comments is enough.
const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      isResolved isOutdated
      opener: comments(first: 1) { nodes { databaseId createdAt author { login } pullRequestReview { databaseId } } }
      comments(last: 100) { nodes { databaseId createdAt author { login } } }
    }
  } } }
}`;

/** Pages of 100 review threads read at most; a pull request with more is not read at all. */
const THREAD_PAGES = 10;

/** Every review thread of the pull request; only GraphQL tells whether a thread is resolved. */
export async function listReviewThreads(gh: GithubFetch, repo: string, number: number): Promise<ReviewThread[]> {
  const [owner, name] = repo.split("/");
  const threads: ReviewThread[] = [];
  let after: string | null = null;
  for (let page = 0; page < THREAD_PAGES; page++) {
    const reply = await json(gh, "/graphql", { method: "POST", body: JSON.stringify({ query: THREADS_QUERY, variables: { owner, name, number, after } }), headers: { "content-type": "application/json" } });
    const { reviewThreads } = ThreadsReply.assert(reply).data.repository.pullRequest;
    threads.push(...reviewThreads.nodes);
    after = reviewThreads.pageInfo.hasNextPage ? reviewThreads.pageInfo.endCursor : null;
    if (after === null) return threads;
  }
  throw new Error(`more than ${THREAD_PAGES * 100} review threads`);
}

/** The ids of the code reviews `appLogin`, the App's bot account, sent: its own reviews that carry the marker. */
async function ownCodeReviews(gh: GithubFetch, repo: string, number: number, appLogin: string): Promise<Set<number>> {
  const reviews = await jsonAll<{ id: number; user: { login: string } | null; body: string }>(gh, `/repos/${repo}/pulls/${number}/reviews?per_page=100`);
  return new Set(reviews.filter((review) => review.user?.login === appLogin && carries(review, CODE_REVIEW_MARKER)).map((review) => review.id));
}

/**
 * Why a merge waits on the review threads: one neither resolved nor outdated, or threads that could not be read.
 * Threads of the code reviews the App sent are left to the code review's own hold.
 */
export async function unresolvedThreadsHold(gh: GithubFetch, repo: string, number: number, appLogin: string): Promise<string | undefined> {
  try {
    const [threads, own] = await Promise.all([listReviewThreads(gh, repo, number), ownCodeReviews(gh, repo, number, appLogin)]);
    const open = threads.filter(function people(thread) {
      const review = thread.opener.nodes[0]?.pullRequestReview?.databaseId;
      return !thread.isResolved && !thread.isOutdated && (review === undefined || !own.has(review));
    });
    // GitHub shows a deleted account as ghost.
    return threadsHold(open.map((thread) => thread.opener.nodes[0]?.author?.login ?? "ghost"));
  } catch (err) {
    return threadsUnread(errorText(err));
  }
}

/** Reviewers whose latest review still stands on the current head, when the review names its commit. */
export function reviewedOnHead(reviews: Review[], headSha: string): string[] {
  const latest = new Map<string, Review>();
  for (const r of reviews) if (r.reviewer && r.state !== "PENDING") latest.set(r.reviewer, r);
  return [...latest].flatMap(([login, r]) => (r.state !== "DISMISSED" && (r.commitId === undefined || r.commitId === headSha) ? [login] : []));
}

export type PrCommit = {
  sha: string;
  message: string;
  author: string;
  committedAt: string;
};

export type PrFile = {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export type PrFilesPage = {
  files: PrFile[];
  /** The offset of the first file not on this page, or of the file whose patch continues on the next page. */
  next?: number;
  /** Where the patch of the file at `next` continues; pass it back as `patchOffset` to read the rest. */
  patchNext?: number;
};

export type IssueComment = {
  id: number;
  author: string;
  bot: boolean;
  body: string;
  createdAt: string;
};

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string") return value;
  return "";
}

function prCommit(row: any): PrCommit {
  const commit = row.commit ?? {};
  return {
    sha: typeof row.sha === "string" ? row.sha : "",
    message: typeof commit.message === "string" ? commit.message : "",
    author: firstString(row.author?.login, commit.author?.name),
    committedAt: firstString(commit.committer?.date, commit.author?.date),
  };
}

export async function listPrCommits(gh: GithubFetch, repo: string, number: number): Promise<PrCommit[]> {
  const rows = await jsonAll<any>(gh, `/repos/${repo}/pulls/${number}/commits?per_page=100`);
  return rows.map(prCommit);
}

export type PathCommits = { commits: PrCommit[]; truncated: boolean };

/** The default branch's commits that changed `path` since `since`, newest first: one page, `truncated` when the window holds more. */
export async function listPathCommits(gh: GithubFetch, repo: string, path: string, since: string): Promise<PathCommits> {
  const res = await request(gh, `/repos/${repo}/commits?path=${encodeURIComponent(path)}&since=${encodeURIComponent(since)}&per_page=100`);
  const rows = (await res.json()) as any[];
  return { commits: rows.map(prCommit), truncated: NEXT_LINK.test(res.headers.get("link") ?? "") };
}

function prFile(row: any): PrFile {
  const file: PrFile = {
    path: typeof row.filename === "string" ? row.filename : "",
    status: typeof row.status === "string" ? row.status : "",
    additions: typeof row.additions === "number" ? row.additions : 0,
    deletions: typeof row.deletions === "number" ? row.deletions : 0,
  };
  if (typeof row.previous_filename === "string") file.previousPath = row.previous_filename;
  if (typeof row.patch === "string") file.patch = row.patch;
  return file;
}

export async function listPrFiles(gh: GithubFetch, repo: string, number: number): Promise<PrFile[]> {
  const rows = await jsonAll<any>(gh, `/repos/${repo}/pulls/${number}/files?per_page=100`);
  return rows.map(prFile);
}

const PR_FILES_PER_PAGE = 100;
// Interchange truncates any tool result over 10 000 characters; a page stays under it with room to spare.
export const PR_FILES_PAGE_CHARS = 9_000;

function fitsPage(page: PrFilesPage, file: PrFile): boolean {
  const worst = { files: [...page.files, file], next: Number.MAX_SAFE_INTEGER, patchNext: Number.MAX_SAFE_INTEGER };
  return JSON.stringify(worst).length <= PR_FILES_PAGE_CHARS;
}

function withoutPatch({ patch: _patch, ...meta }: PrFile): PrFile {
  return meta;
}

/** The end of the longest slice of `patch` from `from` that fits an empty page, never splitting a surrogate pair. */
function patchEnd(meta: PrFile, patch: string, from: number): number {
  let low = from;
  let high = patch.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsPage({ files: [] }, { ...meta, patch: patch.slice(from, middle) })) low = middle;
    else high = middle - 1;
  }
  const code = patch.charCodeAt(low - 1);
  return low > from + 1 && code >= 0xd800 && code <= 0xdbff ? low - 1 : low;
}

/**
 * One page of a pull request's files from `offset`, under the tool-result cap. Metadata is never dropped: a file that
 * does not fit starts the next page. A patch too long for a page alone is read across pages from `patchOffset`, its
 * pieces joined in order; `patches` false leaves patches out.
 */
export async function listPrFilesPage(gh: GithubFetch, repo: string, number: number, { offset = 0, patchOffset = 0, patches = true }: { offset?: number; patchOffset?: number; patches?: boolean } = {}): Promise<PrFilesPage> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`invalid file offset ${offset}`);
  if (!Number.isSafeInteger(patchOffset) || patchOffset < 0) throw new Error(`invalid patch offset ${patchOffset}`);
  const first = offset - (offset % PR_FILES_PER_PAGE);
  const rows = await json(gh, `/repos/${repo}/pulls/${number}/files?per_page=${PR_FILES_PER_PAGE}&page=${first / PR_FILES_PER_PAGE + 1}`);
  if (!Array.isArray(rows)) throw new Error(`github returned an invalid file page for ${repo}#${number}`);
  const page: PrFilesPage = { files: [] };
  let index = offset - first;
  for (; index < rows.length; index++) {
    const file = prFile(rows[index]);
    const entry = patches ? file : withoutPatch(file);
    const from = page.files.length === 0 ? patchOffset : 0;
    if (from > 0 && from >= (entry.patch?.length ?? 0)) throw new Error(`invalid patch offset ${patchOffset} for ${entry.path}`);
    const rest = from > 0 ? { ...entry, patch: entry.patch!.slice(from) } : entry;
    if (fitsPage(page, rest)) {
      page.files.push(rest);
      continue;
    }
    if (page.files.length > 0) break;
    const meta = withoutPatch(entry);
    const end = patchEnd(meta, entry.patch ?? "", from);
    page.files.push({ ...meta, patch: entry.patch!.slice(from, end) });
    page.next = first + index;
    page.patchNext = end;
    return page;
  }
  if (index < rows.length) page.next = first + index;
  else if (rows.length === PR_FILES_PER_PAGE) page.next = first + PR_FILES_PER_PAGE;
  return page;
}

type RepoDoc = {
  path: string;
  text: string;
};

export type RuleSpan = { path: string; docsBytes: number; rulesBytes: number };

export type RepoDocsPage = {
  docs: RepoDoc[];
  rules: RuleSpan[];
  /** The tree this page was read from; pass it back with `next` so every page reads the same docs. */
  ref: string;
  next?: number;
};

/** The most of a repository's docs any reader is given, in UTF-8 bytes. */
export const REPO_DOCS_MAX_BYTES = 24_000;

/** The most of a repository's contribution rules any reader is given, in UTF-8 bytes, apart from its docs. */
export const REPO_RULES_MAX_BYTES = 8_000;

type DocBlob = { path: string; sha: string; size: number };

/** The root README first, then `docs/`, then the other root docs, then the rest, each in path order. */
function docRank(path: string): number {
  if (/^README\.mdx?$/i.test(path)) return 0;
  if (path.startsWith("docs/")) return 1;
  return path.includes("/") ? 3 : 2;
}

function byPath(a: Pick<DocBlob, "path">, b: Pick<DocBlob, "path">): number {
  return compare(a.path, b.path);
}

function byDocOrder(a: Pick<DocBlob, "path">, b: Pick<DocBlob, "path">): number {
  return docRank(a.path) - docRank(b.path) || byPath(a, b);
}

function byRuleOrder(a: Pick<DocBlob, "path">, b: Pick<DocBlob, "path">): number {
  return contributionRuleRank(a.path)! - contributionRuleRank(b.path)! || byPath(a, b);
}

function budget(blobs: DocBlob[], max: number): Map<string, number> {
  const reach = new Map<string, number>();
  let read = 0;
  for (const blob of blobs) {
    const size = Math.min(blob.size, max - read);
    if (size <= 0) break;
    reach.set(blob.path, size);
    read += size;
  }
  return reach;
}

async function docTree(gh: GithubFetch, repo: string, ref: string): Promise<{ sha: string; blobs: DocBlob[] }> {
  const tree = await json(gh, `/repos/${repo}/git/trees/${segment(ref)}?recursive=1`);
  if (typeof tree?.sha !== "string" || !Array.isArray(tree.tree)) throw new Error(`github returned an invalid tree for ${repo}@${ref}`);
  const blobs = (tree.tree as any[]).flatMap((row) => (row?.type === "blob" && typeof row.path === "string" && typeof row.sha === "string" && typeof row.size === "number" && isDocPath(row.path)
    ? [{ path: row.path as string, sha: row.sha as string, size: row.size as number }]
    : []));
  return { sha: tree.sha, blobs: blobs.sort(byDocOrder) };
}

async function blobBytes(gh: GithubFetch, repo: string, sha: string): Promise<Uint8Array> {
  const res = await request(gh, `/repos/${repo}/git/blobs/${sha}`, { headers: { accept: "application/vnd.github.raw+json" } });
  return new Uint8Array(await res.arrayBuffer());
}

function isContinuation(bytes: Uint8Array, at: number): boolean {
  return at > 0 && at < bytes.length && (bytes[at]! & 0xc0) === 0x80;
}

/** `at` moved back to the start of the UTF-8 character it falls inside, so no slice splits a character. */
function charStart(bytes: Uint8Array, at: number): number {
  while (isContinuation(bytes, at)) at--;
  return at;
}

function nextChar(bytes: Uint8Array, at: number): number {
  do at++;
  while (isContinuation(bytes, at));
  return at;
}

const utf8 = new TextDecoder();

export function fitsDocsPage(page: RepoDocsPage, doc: RepoDoc): boolean {
  return JSON.stringify({ ...page, docs: [...page.docs, doc], next: Number.MAX_SAFE_INTEGER }).length <= PR_FILES_PAGE_CHARS;
}

function fittingEnd(page: RepoDocsPage, path: string, bytes: Uint8Array, from: number): number {
  let low = from;
  let high = bytes.length;
  while (low < high) {
    let middle = charStart(bytes, Math.ceil((low + high) / 2));
    if (middle <= low) middle = nextChar(bytes, low);
    if (middle > high) break;
    if (fitsDocsPage(page, { path, text: utf8.decode(bytes.subarray(from, middle)) })) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * One page of the repository's docs at `ref` (the default branch when absent). The docs are taken in order up to
 * REPO_DOCS_MAX_BYTES and, apart from them, the contribution rules in their own order up to REPO_RULES_MAX_BYTES, so a
 * long `docs/` never crowds the rules out; each doc is read once, as far as either reaches. `offset` counts bytes across
 * the docs read, so earlier docs are sized from the tree rather than fetched; a doc longer than a page continues on the
 * next one under the same path.
 */
export async function readRepoDocsPage(gh: GithubFetch, repo: string, { ref, offset = 0 }: { ref?: string; offset?: number } = {}): Promise<RepoDocsPage> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`invalid docs offset ${offset}`);
  ref ??= String((await json(gh, `/repos/${repo}`)).default_branch);
  const { sha, blobs } = await docTree(gh, repo, ref);
  const docs = budget(blobs, REPO_DOCS_MAX_BYTES);
  const rules = budget(blobs.filter((blob) => contributionRuleRank(blob.path) !== undefined).sort(byRuleOrder), REPO_RULES_MAX_BYTES);
  const page: RepoDocsPage = { docs: [], rules: [...rules].map(([path, rulesBytes]) => ({ path, docsBytes: docs.get(path) ?? 0, rulesBytes })), ref: sha };
  let start = 0;
  for (const blob of blobs) {
    const size = Math.max(docs.get(blob.path) ?? 0, rules.get(blob.path) ?? 0);
    if (size === 0) continue;
    if (offset < start + size) {
      const all = await blobBytes(gh, repo, blob.sha);
      const bytes = all.subarray(0, charStart(all, size));
      const from = Math.max(offset - start, 0);
      const end = fittingEnd(page, blob.path, bytes, from);
      if (end > from) page.docs.push({ path: blob.path, text: utf8.decode(bytes.subarray(from, end)) });
      if (end < bytes.length) {
        page.next = start + end;
        return page;
      }
    }
    start += size;
  }
  return page;
}

export function repoDocs(pages: readonly RepoDocsPage[]): { docs: Record<string, string>; rules: Record<string, string> } {
  const texts: Record<string, string> = {};
  for (const page of pages) for (const { path, text } of page.docs) texts[path] = (texts[path] ?? "") + text;
  const spans = new Map((pages.at(-1)?.rules ?? []).map((span) => [span.path, span]));
  const docs: Record<string, string> = {};
  for (const [path, text] of Object.entries(texts)) {
    const span = spans.get(path);
    if (!span) docs[path] = text;
    else if (span.docsBytes > 0) docs[path] = leadingBytes(text, span.docsBytes);
  }
  const rules: Record<string, string> = {};
  for (const span of spans.values()) rules[span.path] = leadingBytes(texts[span.path] ?? "", span.rulesBytes);
  return { docs, rules };
}

const utf8Encoder = new TextEncoder();

/** Never splits a character. */
function leadingBytes(text: string, limit: number): string {
  const bytes = utf8Encoder.encode(text);
  return limit >= bytes.length ? text : utf8.decode(bytes.subarray(0, charStart(bytes, limit)));
}

/**
 * What `repoDocs` makes of the pages of `readRepoDocsPage`, from a tree's file paths and a reader of a file's bytes,
 * for a reader that lists a tree without its blobs' sizes.
 */
export async function readRepoDocs(paths: string[], read: (path: string) => Promise<Uint8Array>): Promise<{ docs: Record<string, string>; rules: Record<string, string> }> {
  const files = new Map<string, Uint8Array>();
  async function leading(ordered: Pick<DocBlob, "path">[], max: number): Promise<Record<string, string>> {
    const texts: Record<string, string> = {};
    let start = 0;
    for (const { path } of ordered) {
      if (start >= max) break;
      const bytes = files.get(path) ?? await read(path);
      files.set(path, bytes);
      const size = Math.min(bytes.length, max - start);
      if (size <= 0) break;
      texts[path] = utf8.decode(bytes.subarray(0, charStart(bytes, size)));
      start += size;
    }
    return texts;
  }
  const blobs = paths.filter(isDocPath).map((path) => ({ path })).sort(byDocOrder);
  const docs = Object.fromEntries(Object.entries(await leading(blobs, REPO_DOCS_MAX_BYTES)).filter(([, text]) => text));
  const rules = await leading(blobs.filter((blob) => contributionRuleRank(blob.path) !== undefined).sort(byRuleOrder), REPO_RULES_MAX_BYTES);
  return { docs, rules };
}

export async function listIssueComments(gh: GithubFetch, repo: string, number: number): Promise<IssueComment[]> {
  const rows = await jsonAll<any>(gh, `/repos/${repo}/issues/${number}/comments?per_page=100`);
  return rows.map((row) => ({
    id: typeof row.id === "number" ? row.id : 0,
    author: typeof row.user?.login === "string" ? row.user.login : "",
    bot: row.user?.type === "Bot",
    body: typeof row.body === "string" ? row.body : "",
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
  }));
}

/** Something an account did on a pull request; `state` is a review's, upper case as the reviews API gives it. */
export type TimelineEvent = { kind: string; actor: string; bot: boolean; at: string; state?: string };

/** When a pull request was opened and closed; `author` is null for a deleted account. */
export type PrTimes = { number: number; author: string | null; createdAt: string; closedAt: string | null };

function prTimesOf(p: any): PrTimes {
  return { number: p.number, author: p.user?.login ?? null, createdAt: p.created_at, closedAt: p.closed_at };
}

export async function getPrTimes(gh: GithubFetch, repo: string, number: number): Promise<PrTimes> {
  return prTimesOf(await json(gh, `/repos/${repo}/pulls/${number}`));
}

/** Commits carry a git identity rather than an account, so events without an actor are left out. */
function timelineEvent(row: any): TimelineEvent[] {
  const user = row.actor ?? row.user;
  const at = row.created_at ?? row.submitted_at;
  if (typeof user?.login !== "string" || typeof at !== "string") return [];
  return [{ kind: row.event, actor: user.login, bot: user.type === "Bot", at, ...(typeof row.state === "string" && { state: row.state.toUpperCase() }) }];
}

/** The first page only, oldest first, which holds the first responses and approvals of all but the busiest pull requests. */
export async function listPrTimeline(gh: GithubFetch, repo: string, number: number): Promise<TimelineEvent[]> {
  const rows: unknown = await json(gh, `/repos/${repo}/issues/${number}/timeline?per_page=100`);
  if (!Array.isArray(rows)) throw new Error(`github returned an invalid timeline for ${repo}#${number}`);
  return rows.flatMap(timelineEvent);
}

/** The 50 newest-created pull requests closed before `before`; one search call. */
export async function searchClosedPrsBefore(gh: GithubFetch, repo: string, before: Date): Promise<PrTimes[]> {
  const q = `repo:${repo} is:pr is:closed closed:<${before.toISOString().slice(0, 19)}Z`;
  const page = await json(gh, `/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=50`);
  if (!Array.isArray(page?.items)) throw new Error(`github returned an invalid search page for ${repo}`);
  return page.items.map(prTimesOf);
}

export type LinkedIssue = {
  number: number;
  title: string;
  state: string;
  body: string;
  url: string;
};

const ISSUE_REF = /(?:^|[\s(])#(\d+)\b/g;

/** References GitHub resolves to issues, not pull requests. */
export async function listReferencedIssues(gh: GithubFetch, repo: string, number: number, text: string): Promise<LinkedIssue[]> {
  const refs = [...new Set([...text.matchAll(ISSUE_REF)].map((m) => Number(m[1])))].filter((n) => n !== number);
  const issues: LinkedIssue[] = [];
  for (const ref of refs) {
    const res = await gh(`/repos/${repo}/issues/${ref}`, { headers: { accept: "application/vnd.github+json" } });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`github GET /repos/${repo}/issues/${ref} -> ${res.status}`);
    const row = await res.json() as Record<string, any>;
    if (row.pull_request) continue;
    issues.push({
      number: ref,
      title: typeof row.title === "string" ? row.title : "",
      state: typeof row.state === "string" ? row.state : "",
      body: typeof row.body === "string" ? row.body : "",
      url: typeof row.html_url === "string" ? row.html_url : "",
    });
  }
  return issues;
}

export function lowercase(name: string): string {
  return name.toLowerCase();
}

/** GitHub logins, org names, team slugs and label names are case-insensitive. */
export function missingFrom(have: string[] | undefined, wanted: string[]): string[] {
  const held = new Set((have ?? []).map(lowercase));
  return wanted.filter((name) => !held.has(lowercase(name)));
}

/** Marks the changes the request-changes Do requested, so a repeat on the same head finds them. */
export const REQUEST_CHANGES_DO_MARKER = "<!-- corbits-request-changes -->";

/** Marks a code review sent to a pull request, so sending the same head again finds it. */
export const CODE_REVIEW_MARKER = "<!-- corbits-code-review -->";

/**
 * A code review sent to the pull request: the review's page, the account that wrote it, whether it read an earlier
 * commit than the head, and each inline comment; `line` is null once the comment is outdated.
 */
export type PostedCodeReview = {
  url: string;
  author: string;
  earlier: boolean;
  comments: ({ path: string; line: number | null; url: string } & ReturnType<typeof parseFindingHeadline>)[];
};

/**
 * GitHub gives the Bot type only to App accounts, so a person who copies the marker into their own review is not read.
 * Without the App's credential its login is unknown, so another App on the repository could still write the marker.
 */
function isAppReview(review: any): boolean {
  return review.user?.type === "Bot" && typeof review.user.login === "string" && review.user.login.endsWith("[bot]") && carries(review, CODE_REVIEW_MARKER);
}

/** The newest code review sent to the pull request, read without the App's credential; null when none was sent. */
export async function getPostedCodeReview(gh: GithubFetch, repo: string, number: number): Promise<PostedCodeReview | null> {
  const [reviews, pr] = await Promise.all([jsonAll<any>(gh, `/repos/${repo}/pulls/${number}/reviews?per_page=100`), readPr(gh, repo, number)]);
  const review = reviews.findLast(isAppReview);
  if (!review) return null;
  const comments = await jsonAll<any>(gh, `/repos/${repo}/pulls/${number}/reviews/${review.id}/comments?per_page=100`);
  return {
    url: review.html_url,
    author: review.user.login,
    earlier: review.commit_id !== pr.sha,
    comments: comments.map((c) => ({ ...parseFindingHeadline(c.body), path: c.path, line: c.line ?? null, url: c.html_url })),
  };
}

const RepoFile = type({ type: "string", sha: "string", "content?": "string", "encoding?": "string", html_url: "string" });

/** `text` is null for a file over 1 MB, whose content GitHub leaves out; a directory or submodule at the path is not a file. */
export type RepoFileRead = { kind: "file"; sha: string; text: string | null; url: string } | { kind: "not-a-file" };

// Not Buffer, so the browser extension reads files through this too.
function base64Text(content: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\s/g, "")), (char) => char.charCodeAt(0)));
}

/** A file on `ref`, the default branch when none is named, or undefined when nothing is there. */
export async function readRepoFile(gh: GithubFetch, repo: string, path: string, ref?: string): Promise<RepoFileRead | undefined> {
  const url = `/repos/${repo}/contents/${path}`;
  const at = ref === undefined ? url : `${url}?ref=${encodeURIComponent(ref)}`;
  return readRepoFileResponse(await gh(at, { headers: { accept: "application/vnd.github+json" } }), url);
}

/** A contents API response for one path, read as `readRepoFile` reads it; for a caller that sent the request itself. */
export async function readRepoFileResponse(res: Response, url: string): Promise<RepoFileRead | undefined> {
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`github GET ${url} -> ${res.status}`);
  const body: unknown = await res.json();
  if (Array.isArray(body)) return { kind: "not-a-file" };
  const file = RepoFile.assert(body);
  if (file.type !== "file") return { kind: "not-a-file" };
  const text = file.encoding === "base64" && file.content !== undefined ? base64Text(file.content) : null;
  return { kind: "file", sha: file.sha, text, url: file.html_url };
}

type DirEntry = { name: string; path: string; type: string };

// GitHub finds a pull request template in the root, `docs/` or `.github/`, in any case, alone or as a folder of them.
const PR_TEMPLATE_DIRS = ["", "docs", ".github"];
const PR_TEMPLATE = /^pull_request_template\.md$/i;
const PR_TEMPLATE_FOLDER = /^pull_request_template$/i;

/** A folder's entries on the default branch; none when nothing is there. */
async function listFolder(gh: GithubFetch, repo: string, path: string): Promise<DirEntry[]> {
  const url = path ? `/repos/${repo}/contents/${path}` : `/repos/${repo}/contents`;
  const res = await gh(url, { headers: { accept: "application/vnd.github+json" } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`github GET ${url} -> ${res.status}`);
  const body: unknown = await res.json();
  return Array.isArray(body) ? body.filter((row): row is DirEntry => typeof row?.name === "string" && typeof row?.path === "string" && typeof row?.type === "string") : [];
}

async function templatesIn(gh: GithubFetch, repo: string): Promise<string[]> {
  const entries = (await Promise.all(PR_TEMPLATE_DIRS.map((path) => listFolder(gh, repo, path)))).flat();
  const folders = entries.filter((entry) => entry.type === "dir" && PR_TEMPLATE_FOLDER.test(entry.name));
  const inFolders = (await Promise.all(folders.map((folder) => listFolder(gh, repo, folder.path)))).flat().filter((entry) => entry.type === "file" && /\.md$/i.test(entry.name));
  const files = [...entries.filter((entry) => entry.type === "file" && PR_TEMPLATE.test(entry.name)), ...inFolders];
  const reads = await Promise.all(files.map((file) => readRepoFile(gh, repo, file.path)));
  return reads.flatMap((read) => (read?.kind === "file" && read.text !== null ? [read.text] : []));
}

/**
 * The text of each pull request template GitHub offers for the repository, from its default branch, or, as GitHub
 * falls back when it has none, from its owner's `.github` repository.
 */
export async function readPrTemplates(gh: GithubFetch, repo: string): Promise<string[]> {
  const own = await templatesIn(gh, repo);
  return own.length ? own : templatesIn(gh, `${repo.split("/")[0]}/.github`);
}

const API_ORIGIN = "https://api.github.com";

/**
 * GET `url`, following a renamed or transferred repository's permanent redirect to its new API path; the credential
 * handle does not follow redirects itself.
 */
export async function getFollowingMove(gh: GithubFetch, url: string, init?: RequestInit): Promise<Response> {
  const res = await gh(url, init);
  const moved = res.headers.get("location");
  if ((res.status === 301 || res.status === 307) && moved?.startsWith(`${API_ORIGIN}/`)) return gh(moved.slice(API_ORIGIN.length), init);
  return res;
}

/** The text of `path` at commit `sha`, or undefined when nothing is there. */
export async function readFileAt(gh: GithubFetch, repo: string, sha: string, path: string): Promise<string | undefined> {
  const url = `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`;
  const res = await getFollowingMove(gh, url, { headers: { accept: "application/vnd.github.raw+json" } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`github GET ${url} -> ${res.status}`);
  return res.text();
}

export type CodeownersRule = {
  pattern: string;
  owners: string[];
};

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** GitHub reads the first CODEOWNERS in .github/, the root, then docs/; none means no rules. */
export async function readCodeowners(gh: GithubFetch, input: { repo: string; baseRef: string }): Promise<CodeownersRule[]> {
  for (const file of CODEOWNERS_PATHS) {
    const path = `/repos/${input.repo}/contents/${file}?ref=${encodeURIComponent(input.baseRef)}`;
    const res = await gh(path, { headers: { accept: "application/vnd.github.raw+json" } });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`github GET ${path} -> ${res.status}`);
    return parseCodeowners(await res.text());
  }
  return [];
}

// GitHub ignores negations and character ranges, so those rules never match.
const UNSUPPORTED_PATTERN = /^!|\[/;

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const line of text.split("\n")) {
    const [pattern, ...rest] = line.replace(/(^|\s)#.*$/, "").trim().split(/\s+/);
    if (!pattern || UNSUPPORTED_PATTERN.test(pattern)) continue;
    rules.push({ pattern, owners: rest.filter((owner) => owner.startsWith("@")) });
  }
  return rules;
}

// Gitignore-style, except that a trailing `*` stays one level deep as GitHub documents.
function codeownersGlobs(pattern: string): string[] {
  const directory = pattern.endsWith("/");
  let glob = pattern.replace(/^\//, "").replace(/\/$/, "");
  if (!pattern.slice(0, -1).includes("/")) glob = `**/${glob}`;
  if (directory) return [`${glob}/**`];
  return glob.endsWith("*") ? [glob] : [glob, `${glob}/**`];
}

export type Codeowners = { users: string[]; teams: string[] };

const GLOB_OPTIONS = { dot: true, nonegate: true, nobrace: true, noext: true };

/** Per path the last matching rule wins; `@org/team` owners are returned by team slug. */
export function codeownersFor(rules: CodeownersRule[], paths: string[]): Codeowners {
  const users = new Set<string>();
  const teams = new Set<string>();
  const matchers = rules.map((rule) => ({ owners: rule.owners, globs: codeownersGlobs(rule.pattern) }));
  for (const path of paths) {
    const rule = matchers.findLast((m) => m.globs.some((glob) => minimatch(path, glob, GLOB_OPTIONS)));
    for (const owner of rule?.owners ?? []) {
      const [name, team] = owner.slice(1).split("/");
      if (team) teams.add(team);
      else if (name) users.add(name);
    }
  }
  return { users: [...users], teams: [...teams] };
}

/** Without its author. */
export async function codeownersForPr(gh: GithubFetch, repo: string, number: number): Promise<Codeowners> {
  const pr = await json(gh, `/repos/${repo}/pulls/${number}`);
  // GitHub applies the base branch's CODEOWNERS, so a pull request cannot edit its own reviewers.
  const rules = await readCodeowners(gh, { repo, baseRef: pr.base.ref });
  const files = await listPrFiles(gh, repo, number);
  const owners = codeownersFor(rules, files.map((file) => file.path));
  const author = lowercase(pr.user?.login ?? "");
  return { users: owners.users.filter((user) => lowercase(user) !== author), teams: owners.teams };
}
