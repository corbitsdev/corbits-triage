import { getPr, isTriageComment, json, jsonAll, lowercase, REQUEST_CHANGES_DO_MARKER, TRIAGE_COMMENT_MARKER, type AppLogin, type GithubFetch } from "@corbits/github-reads";
import type { ArtifactRef, PolicySource } from "@corbits/triage-contracts";
import { type } from "arktype";

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
  /** What the comment is written for; without it the comment is written whatever it said before. */
  header?: TriageHeader;
  close: boolean;
}

/** What a Triage comment was written for, kept in its marker so a later run can tell what changed. */
export type TriageHeader = { head: string; policy: PolicySource | null; verdict: string };

const ArtifactRefShape = type({ id: "string", version: "number" });
const TriageHeaderShape = type({ head: "string", policy: type({ repo: ArtifactRefShape, "shared?": ArtifactRefShape }).or("null"), verdict: "string" });

// Starts like the current marker, so the hub still reads it as Triage's own, but is never taken as the current comment.
const SUPERSEDED_MARKER = "<!-- corbits-triage-superseded";
const SUPERSEDES_NOTE = "This supersedes the comment above because the rules changed";

function markerOf(header: TriageHeader): string {
  return `<!-- corbits-triage ${JSON.stringify(header)} -->`;
}

/** The header on a marked comment's first line; undefined on one written before headers. */
function headerOf(body: string): TriageHeader | undefined {
  const match = /^<!-- corbits-triage(?:-superseded)? (\{.*\}) -->/.exec(body);
  if (!match) return undefined;
  try {
    const parsed = TriageHeaderShape(JSON.parse(match[1]!));
    return parsed instanceof type.errors ? undefined : parsed;
  } catch {
    return undefined;
  }
}

function isSuperseded(body: string): boolean {
  return body.startsWith(SUPERSEDED_MARKER);
}

/** The text below the marker, less a supersede note, so a rerun compares only what it renders. */
function renderedText(body: string): string {
  const text = body.slice(body.indexOf("\n") + 1);
  return text.startsWith(SUPERSEDES_NOTE) ? text.slice(text.indexOf("\n\n") + 2) : text;
}

function sameRef(a: ArtifactRef | undefined, b: ArtifactRef | undefined): boolean {
  return a?.id === b?.id && a?.version === b?.version;
}

function samePolicy(a: PolicySource | null, b: PolicySource | null): boolean {
  return sameRef(a?.repo, b?.repo) && sameRef(a?.shared, b?.shared);
}

/** The rules changed under an unchanged head and changed its verdict, so the earlier comment is history rather than stale. */
function supersedes(before: TriageHeader, after: TriageHeader): boolean {
  return before.head === after.head && before.verdict !== after.verdict && !samePolicy(before.policy, after.policy);
}

function versionChange(name: string, before: ArtifactRef | undefined, after: ArtifactRef | undefined): string[] {
  if (sameRef(before, after)) return [];
  return [`${name} ${before ? `version ${before.version}` : "none"} → ${after ? `version ${after.version}` : "none"}`];
}

function supersedesNote(before: TriageHeader, after: TriageHeader): string {
  const changes = [...versionChange("repository policy", before.policy?.repo, after.policy?.repo), ...versionChange("workspace policy", before.policy?.shared, after.policy?.shared)];
  return `${SUPERSEDES_NOTE}: ${changes.join(", ")}.`;
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
type MarkedComment = IssueCommentRow & { body: string };
type WrittenComment = { commentId: number; updated: boolean; unchanged?: string };

async function issueComments(gh: GithubFetch, repo: string, number: number): Promise<IssueCommentRow[]> {
  return jsonAll<IssueCommentRow>(gh, `/repos/${repo}/issues/${number}/comments?per_page=100`);
}

function marked(comments: IssueCommentRow[]): MarkedComment[] {
  return comments.filter((c): c is MarkedComment => c.user?.type === "Bot" && typeof c.body === "string" && isTriageComment(c.body));
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

/** Undefined when GitHub refuses: an installation token can edit only its own App's comments. */
async function editComment(gh: GithubFetch, repo: string, id: number, body: string): Promise<{ id: number } | undefined> {
  const path = `/repos/${repo}/issues/comments/${id}`;
  const edit = send("PATCH", { body });
  const res = await gh(path, { ...edit, headers: { accept: "application/vnd.github+json", ...edit.headers } });
  if (res.status === 403 || res.status === 404) return undefined;
  if (!res.ok) throw new Error(`github PATCH ${path} -> ${res.status}`);
  return await res.json() as { id: number };
}

async function postComment(gh: GithubFetch, { repo, number, body }: TriageCommentInput): Promise<WrittenComment> {
  const posted = await json(gh, `/repos/${repo}/issues/${number}/comments`, send("POST", { body }));
  return { commentId: posted.id, updated: false };
}

/** Edits the first current Triage comment GitHub lets this App edit, creating one only when there is none. */
async function upsert(gh: GithubFetch, input: TriageCommentInput, current: MarkedComment[]): Promise<WrittenComment> {
  for (const candidate of current) {
    const edited = await editComment(gh, input.repo, candidate.id, input.body);
    if (edited) return { commentId: edited.id, updated: true };
  }
  return postComment(gh, input);
}

/** Edits the App's one Triage comment on the pull request, creating it only when none exists. */
export async function upsertTriageComment(gh: GithubFetch, input: TriageCommentInput): Promise<WrittenComment> {
  const current = marked(await issueComments(gh, input.repo, input.number)).filter((c) => !isSuperseded(c.body));
  return upsert(gh, { ...input, body: `${TRIAGE_COMMENT_MARKER}\n${input.body}` }, current);
}

/** When the comment last said exactly this for this head, policy versions and verdict; undefined when anything differs. */
function unchangedSince(latest: MarkedComment, header: TriageHeader, text: string): string | undefined {
  const before = headerOf(latest.body);
  if (!before || before.head !== header.head || before.verdict !== header.verdict || !samePolicy(before.policy, header.policy)) return undefined;
  return renderedText(latest.body) === text ? latest.updated_at : undefined;
}

/**
 * The header the new comment supersedes: the current one's once it is marked superseded, or, when a retry finds no
 * current comment, the last superseded one's, so the new comment still names what changed.
 */
function earlierHeader(own: MarkedComment[], current: MarkedComment[], superseded: boolean): TriageHeader | undefined {
  if (superseded) return headerOf(current[0]!.body);
  if (current.length > 0) return undefined;
  const last = own.at(-1);
  return last && headerOf(last.body);
}

/**
 * Writes nothing when the App's comment already says this for this head, policy versions and verdict; supersedes it
 * when only the rules changed the verdict on the same head; otherwise edits it in place. Only the App's own comments
 * are read, so a copied marker never decides what Triage writes. The earlier comment is marked superseded before the
 * new one is posted, so a retry never leaves two current comments.
 */
async function writeTriageComment(gh: GithubFetch, input: TriageCommentInput & { header?: TriageHeader }, login: AppLogin): Promise<WrittenComment> {
  const { repo, number, header } = input;
  if (!header) return upsertTriageComment(gh, input);
  const app = await login();
  const own = marked(await issueComments(gh, repo, number)).filter((c) => c.user?.login === app);
  const current = own.filter((c) => !isSuperseded(c.body));
  const latest = current[0];
  const since = latest && unchangedSince(latest, header, input.body);
  if (latest && since) return { commentId: latest.id, updated: false, unchanged: `unchanged since ${since}` };
  const before = latest && headerOf(latest.body);
  const superseded = before !== undefined && supersedes(before, header)
    && await editComment(gh, repo, latest!.id, `${SUPERSEDED_MARKER} ${JSON.stringify(before)} -->\nSuperseded by the comment below.`) !== undefined;
  const earlier = earlierHeader(own, current, superseded);
  if (earlier && supersedes(earlier, header)) return postComment(gh, { repo, number, body: `${markerOf(header)}\n${supersedesNote(earlier, header)}\n\n${input.body}` });
  return upsert(gh, { repo, number, body: `${markerOf(header)}\n${input.body}` }, current);
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

