import { getPr, isTriageComment, json, jsonAll, lowercase, REQUEST_CHANGES_DO_MARKER, TRIAGE_COMMENT_MARKER, type AppLogin, type GithubFetch } from "@corbits/github-reads";
import { HTML_MARKERS, upsertMarked, writeHeadedComment, type CommentHost, type MarkedComment, type TriageHeader, type WrittenComment } from "@corbits/triage-contracts";

function send(method: string, body: unknown): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  };
}

export interface MirrorInput {
  repo: string;
  number: number;
  labels: string[];
  /** Labels the caller owns; the mirror removes only these. Optional so requests built before it existed remove nothing. */
  owned?: readonly string[];
  comment?: string;
  /** What the comment is written for; without it the comment is written whatever it said before. */
  header?: TriageHeader;
  close: boolean;
}

/**
 * Adds the labels of `add` the pull request lacks, and removes those of `remove` it holds that `add` does not name.
 * GitHub label names are case-insensitive. Adding first means a failure part-way leaves an extra label rather than none.
 */
export async function syncLabels(gh: GithubFetch, input: { repo: string; number: number; current: string[]; add: readonly string[]; remove: readonly string[] }) {
  const { repo, number, current } = input;
  const present = new Set(current.map(lowercase));
  const kept = new Set(input.add.map(lowercase));
  const removable = new Set(input.remove.map(lowercase));
  const added = input.add.filter((name) => !present.has(lowercase(name)));
  const removed = current.filter((name) => removable.has(lowercase(name)) && !kept.has(lowercase(name)));
  if (added.length) await json(gh, `/repos/${repo}/issues/${number}/labels`, send("POST", { labels: added }));
  for (const name of removed) await json(gh, `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, { method: "DELETE" });
  return { added, removed };
}

export const NOT_OPEN = "the pull request is not open";

/** `login` names the App, whose comments alone are read back. */
export async function mirror(gh: GithubFetch, i: MirrorInput, login: AppLogin) {
  const { repo, number } = i;
  const pr = await json(gh, `/repos/${repo}/pulls/${number}`);
  // A closed or merged pull request is history; a close Do reads it open before it comes here.
  if (pr.state !== "open") return { commentId: null, updated: false, closed: false, sha: pr.head.sha, skipped: NOT_OPEN };
  // An empty comment means nothing is asked of the author, so an earlier one would be stale instructions.
  if (i.comment === "") await deleteTriageComments(gh, repo, number);
  const posted = i.comment ? await writeTriageComment(gh, { repo, number, body: i.comment, header: i.header }, login) : null;
  const current: string[] = pr.labels.map((label: { name: string }) => label.name);
  await syncLabels(gh, { repo, number, current, add: i.labels, remove: i.owned ?? [] });
  if (i.close) await json(gh, `/repos/${repo}/pulls/${number}`, send("PATCH", { state: "closed" }));
  return { commentId: posted?.commentId ?? null, updated: posted?.updated ?? false, closed: i.close, sha: pr.head.sha, ...(posted?.unchanged && { unchanged: posted.unchanged }) };
}

export type TriageCommentInput = {
  repo: string;
  number: number;
  body: string;
};

type IssueCommentRow = { id: number; body?: unknown; user?: { login?: string; type?: string }; updated_at?: string };
type MarkedRow = IssueCommentRow & { body: string };

async function issueComments(gh: GithubFetch, repo: string, number: number): Promise<IssueCommentRow[]> {
  return jsonAll<IssueCommentRow>(gh, `/repos/${repo}/issues/${number}/comments?per_page=100`);
}

function marked(comments: IssueCommentRow[]): MarkedRow[] {
  return comments.filter((c): c is MarkedRow => c.user?.type === "Bot" && typeof c.body === "string" && isTriageComment(c.body));
}

function markedComment(row: MarkedRow): MarkedComment {
  return { id: row.id, body: row.body, ...(row.updated_at && { updatedAt: row.updated_at }) };
}

async function deleteTriageComments(gh: GithubFetch, repo: string, number: number) {
  for (const candidate of marked(await issueComments(gh, repo, number))) {
    const path = `/repos/${repo}/issues/comments/${candidate.id}`;
    const res = await gh(path, { method: "DELETE", headers: { accept: "application/vnd.github+json" } });
    // Another App's marked comment is not ours to delete.
    if (res.status === 403 || res.status === 404) continue;
    if (!res.ok) throw new Error(`github DELETE ${path} -> ${res.status}`);
  }
}

/** An installation token can edit only its own App's comments, so a refused edit reads as undefined. */
function issueCommentHost(gh: GithubFetch, repo: string, number: number): CommentHost {
  return {
    async edit(id, body) {
      const path = `/repos/${repo}/issues/comments/${id}`;
      const edit = send("PATCH", { body });
      const res = await gh(path, { ...edit, headers: { accept: "application/vnd.github+json", ...edit.headers } });
      if (res.status === 403 || res.status === 404) return undefined;
      if (!res.ok) throw new Error(`github PATCH ${path} -> ${res.status}`);
      return (await res.json() as { id: number }).id;
    },
    async post(body) {
      return (await json(gh, `/repos/${repo}/issues/${number}/comments`, send("POST", { body }))).id;
    },
  };
}

export async function upsertTriageComment(gh: GithubFetch, input: TriageCommentInput): Promise<WrittenComment> {
  const current = marked(await issueComments(gh, input.repo, input.number)).filter((c) => !HTML_MARKERS.isSuperseded(c.body)).map(markedComment);
  return upsertMarked(issueCommentHost(gh, input.repo, input.number), `${TRIAGE_COMMENT_MARKER}\n${input.body}`, current);
}

/** Only the App's own comments are read, so a copied marker never decides what Triage writes. */
async function writeTriageComment(gh: GithubFetch, input: TriageCommentInput & { header?: TriageHeader }, login: AppLogin): Promise<WrittenComment> {
  const { repo, number, header } = input;
  if (!header) return upsertTriageComment(gh, input);
  const app = await login();
  const own = marked(await issueComments(gh, repo, number)).filter((c) => c.user?.login === app).map(markedComment);
  return writeHeadedComment(issueCommentHost(gh, repo, number), HTML_MARKERS, own, header, input.body);
}

export const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/** `commitId` pins the review to that head, so it never lands on commits pushed since. */
export type CreateReviewInput = {
  repo: string;
  number: number;
  body: string;
  event: ReviewEvent;
  commitId?: string;
};

export async function createReview(gh: GithubFetch, input: CreateReviewInput) {
  if (!REVIEW_EVENTS.includes(input.event)) throw new Error("review event must be COMMENT, APPROVE, or REQUEST_CHANGES");
  const posted = await json(gh, `/repos/${input.repo}/pulls/${input.number}/reviews`, send("POST", {
    body: input.body,
    event: input.event,
    ...(input.commitId === undefined ? {} : { commit_id: input.commitId }),
  }));
  return { reviewId: posted.id, state: posted.state, event: input.event };
}

/** Marks an approval the approve Do made, so only those are taken back; a person's approval through the App is theirs. */
export const APPROVE_DO_MARKER = "<!-- corbits-approve -->";

type ReviewRow = { id: number; user?: { login?: string }; state?: string; commit_id?: string; body?: string };

async function reviewsBy(gh: GithubFetch, repo: string, number: number, login: string): Promise<ReviewRow[]> {
  const reviews = await jsonAll<ReviewRow>(gh, `/repos/${repo}/pulls/${number}/reviews?per_page=100`);
  return reviews.filter((review) => review.user?.login === login);
}

/**
 * `login`'s approval of `sha`, still standing or since dismissed, which is not made again: a person who dismissed it does not want it.
 * The App's own dismissal of a stale approval reads the same, so a force-push back to that head is not approved again either,
 * as GitHub itself never restores a dismissed review. A dismissed request for changes is not an approval.
 */
export async function approvalOnHead(gh: GithubFetch, input: { repo: string; number: number; sha: string; login: string }): Promise<number | undefined> {
  const reviews = await reviewsBy(gh, input.repo, input.number, input.login);
  return reviews.find((review) => review.commit_id === input.sha
    && (review.state === "APPROVED" || (review.state === "DISMISSED" && !review.body?.includes(REQUEST_CHANGES_DO_MARKER))))?.id;
}

/** Marks a request for changes triage itself took back, which a later failure on its head may make again. */
const DISMISSED_BY_TRIAGE_MARKER = "<!-- corbits-dismissed -->";

/** The request-changes Do's review of `sha`, still standing or dismissed by a person, which is not made again: a person who dismissed it does not want it. */
export async function changesRequestedOnHead(gh: GithubFetch, input: { repo: string; number: number; sha: string; login: string }): Promise<number | undefined> {
  const reviews = await reviewsBy(gh, input.repo, input.number, input.login);
  return reviews.find((review) => review.commit_id === input.sha
    && (review.state === "CHANGES_REQUESTED" || (review.state === "DISMISSED" && !review.body?.includes(DISMISSED_BY_TRIAGE_MARKER)))
    && review.body?.includes(REQUEST_CHANGES_DO_MARKER))?.id;
}

async function dismissDoReviews(gh: GithubFetch, input: { repo: string; number: number; login: string }, state: string, marker: string, message: string): Promise<number[]> {
  const { repo, number } = input;
  const reviews = await reviewsBy(gh, repo, number, input.login);
  const stale = reviews.filter((review) => review.state === state && review.body?.includes(marker));
  for (const review of stale) {
    await json(gh, `/repos/${repo}/pulls/${number}/reviews/${review.id}/dismissals`, send("PUT", { message, event: "DISMISS" }));
  }
  return stale.map((review) => review.id);
}

/**
 * Dismisses the approve Do's standing approvals, of earlier heads and of this one alike, once the head may not be approved; a dismissed
 * one is no longer APPROVED, so a repeat changes nothing. One on this head stays dismissed when a later run finds it green again, as
 * GitHub never restores a dismissed review either.
 */
export async function dismissDoApprovals(gh: GithubFetch, input: { repo: string; number: number; login: string }): Promise<number[]> {
  return dismissDoReviews(gh, input, "APPROVED", APPROVE_DO_MARKER, "This pull request is no longer ready to approve, so this approval no longer stands.");
}

/**
 * Dismisses the request-changes Do's standing requests once nothing failed is the author's to fix, those of `sha` only
 * when it is given; a repeat changes nothing. Each is marked as triage's own dismissal, so a later failure on its head
 * may request changes again, where a person's dismissal is final.
 */
export async function dismissDoChangeRequests(gh: GithubFetch, input: { repo: string; number: number; login: string; sha?: string }): Promise<number[]> {
  const { repo, number, sha } = input;
  const reviews = await reviewsBy(gh, repo, number, input.login);
  const standing = reviews.filter((review) => review.state === "CHANGES_REQUESTED" && review.body?.includes(REQUEST_CHANGES_DO_MARKER) && (sha === undefined || review.commit_id === sha));
  for (const review of standing) {
    // Marked first, so a failure part-way never leaves a dismissal that reads as a person's.
    await json(gh, `/repos/${repo}/pulls/${number}/reviews/${review.id}`, send("PUT", { body: `${review.body}\n${DISMISSED_BY_TRIAGE_MARKER}` }));
    await json(gh, `/repos/${repo}/pulls/${number}/reviews/${review.id}/dismissals`, send("PUT", { message: "Nothing triage asked to change still fails, so this request no longer stands.", event: "DISMISS" }));
  }
  return standing.map((review) => review.id);
}

export type CreateIssueCommentInput = {
  repo: string;
  number: number;
  body: string;
};

export async function createIssueComment(gh: GithubFetch, input: CreateIssueCommentInput) {
  const posted = await json(gh, `/repos/${input.repo}/issues/${input.number}/comments`, send("POST", { body: input.body }));
  return { commentId: posted.id };
}

export async function addLabels(gh: GithubFetch, input: { repo: string; number: number; labels: string[] }) {
  await json(gh, `/repos/${input.repo}/issues/${input.number}/labels`, send("POST", { labels: input.labels }));
  return { labels: input.labels };
}

export async function addAssignees(gh: GithubFetch, input: { repo: string; number: number; assignees: string[] }) {
  const issue = await json(gh, `/repos/${input.repo}/issues/${input.number}/assignees`, send("POST", { assignees: input.assignees }));
  return { assignees: (issue.assignees ?? []).map((u: any) => u.login) as string[] };
}

export type RequestReviewersInput = {
  repo: string;
  number: number;
  reviewers?: string[];
  teamReviewers?: string[];
};

export async function requestReviewers(gh: GithubFetch, input: RequestReviewersInput) {
  const reviewers = input.reviewers ?? [];
  const teamReviewers = input.teamReviewers ?? [];
  if (reviewers.length + teamReviewers.length === 0) throw new Error("request at least one reviewer or team");
  const pr = await json(gh, `/repos/${input.repo}/pulls/${input.number}/requested_reviewers`, send("POST", {
    reviewers,
    team_reviewers: teamReviewers,
  }));
  return {
    reviewers: (pr.requested_reviewers ?? []).map((u: any) => u.login) as string[],
    teamReviewers: (pr.requested_teams ?? []).map((t: any) => t.slug) as string[],
  };
}

export type MergePrInput = {
  repo: string;
  number: number;
  /** The head that may merge; GitHub refuses the merge once the pull request has moved past it. Defaults to the current head. */
  sha?: string;
};

export async function mergePr(gh: GithubFetch, input: MergePrInput) {
  const pr = await getPr(gh, input.repo, input.number);
  if (pr.mergeable !== true) throw new Error("pull request is not mergeable");
  const merged = await json(gh, `/repos/${input.repo}/pulls/${input.number}/merge`, send("PUT", (input.sha ?? pr.sha) ? { sha: input.sha ?? pr.sha } : {}));
  return { merged: merged.merged === true, sha: merged.sha ?? pr.sha };
}

