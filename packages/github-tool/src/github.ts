import { getPr, isTriageComment, json, jsonAll, lowercase, REQUEST_CHANGES_DO_MARKER, TRIAGE_COMMENT_MARKER, type GithubFetch } from "@corbits/github-reads";

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
  /** Absent leaves the triage comment as it is. */
  comment?: string;
  close: boolean;
}

export async function mirror(gh: GithubFetch, i: MirrorInput) {
  const { repo, number } = i;
  const pr = await json(gh, `/repos/${repo}/pulls/${number}`);
  // An empty comment means nothing is asked of the author, so an earlier one on an open pull request would be stale instructions.
  if (i.comment === "" && pr.state === "open") await deleteTriageComments(gh, repo, number);
  const posted = i.comment ? await upsertTriageComment(gh, { repo, number, body: i.comment }) : null;
  const current: string[] = pr.labels.map((label: { name: string }) => label.name);
  // GitHub label names are case-insensitive.
  const present = new Set(current.map(lowercase));
  const removable = new Set((i.owned ?? []).map(lowercase));
  for (const name of i.labels) removable.delete(lowercase(name));
  const missing = i.labels.filter((name) => !present.has(lowercase(name)));
  const stale = current.filter((name) => removable.has(lowercase(name)));
  // Adding first means a failure part-way leaves an extra triage label rather than none.
  if (missing.length) await json(gh, `/repos/${repo}/issues/${number}/labels`, send("POST", { labels: missing }));
  for (const name of stale) await json(gh, `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (i.close) await json(gh, `/repos/${repo}/pulls/${number}`, send("PATCH", { state: "closed" }));
  return { commentId: posted?.commentId ?? null, updated: posted?.updated ?? false, closed: i.close, sha: pr.head.sha };
}

export type TriageCommentInput = {
  repo: string;
  number: number;
  body: string;
};

async function triageComments(gh: GithubFetch, repo: string, number: number): Promise<Array<{ id: number }>> {
  const comments = await jsonAll<any>(gh, `/repos/${repo}/issues/${number}/comments?per_page=100`);
  return comments.filter((c) => c.user?.type === "Bot" && typeof c.body === "string" && isTriageComment(c.body));
}

async function deleteTriageComments(gh: GithubFetch, repo: string, number: number) {
  for (const candidate of await triageComments(gh, repo, number)) {
    const path = `/repos/${repo}/issues/comments/${candidate.id}`;
    const res = await gh(path, { method: "DELETE", headers: { accept: "application/vnd.github+json" } });
    // Another App's marked comment is not ours to delete.
    if (res.status === 403 || res.status === 404) continue;
    if (!res.ok) throw new Error(`github DELETE ${path} -> ${res.status}`);
  }
}

/** Edits the App's one Triage comment on the pull request, creating it only when none exists. */
export async function upsertTriageComment(gh: GithubFetch, input: TriageCommentInput) {
  const { repo, number } = input;
  const body = `${TRIAGE_COMMENT_MARKER}\n${input.body}`;
  const candidates = await triageComments(gh, repo, number);
  const edit = send("PATCH", { body });
  for (const candidate of candidates) {
    const path = `/repos/${repo}/issues/comments/${candidate.id}`;
    const res = await gh(path, { ...edit, headers: { accept: "application/vnd.github+json", ...edit.headers } });
    // An installation token can edit only its own App's comments, so a refusal means another App wrote this one.
    if (res.status === 403 || res.status === 404) continue;
    if (!res.ok) throw new Error(`github PATCH ${path} -> ${res.status}`);
    const edited = await res.json() as { id: number };
    return { commentId: edited.id, updated: true };
  }
  const posted = await json(gh, `/repos/${repo}/issues/${number}/comments`, send("POST", { body }));
  return { commentId: posted.id, updated: false };
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

/** The request-changes Do's review of `sha`, still standing or since dismissed, which is not made again: a person who dismissed it does not want it. */
export async function changesRequestedOnHead(gh: GithubFetch, input: { repo: string; number: number; sha: string; login: string }): Promise<number | undefined> {
  const reviews = await reviewsBy(gh, input.repo, input.number, input.login);
  return reviews.find((review) => review.commit_id === input.sha
    && (review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED")
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

/** Dismisses the request-changes Do's standing requests once nothing failed is the author's to fix; a repeat changes nothing. */
export async function dismissDoChangeRequests(gh: GithubFetch, input: { repo: string; number: number; login: string }): Promise<number[]> {
  return dismissDoReviews(gh, input, "CHANGES_REQUESTED", REQUEST_CHANGES_DO_MARKER, "Nothing triage asked to change still fails, so this request no longer stands.");
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

