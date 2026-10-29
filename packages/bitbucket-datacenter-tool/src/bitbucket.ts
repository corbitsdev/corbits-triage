import { createHash } from "node:crypto";
import { errorText } from "@corbits/common";
import { plainSegments } from "@corbits/repo-read-tool/host-reads";
import { changesSince, CODE_REVIEW_MARKER, filePath, jsonAll, repoPath, TRIAGE_BUILD_KEY, type BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { findingSection, inlineFindingText, isLinkReferenceTriageComment, LINK_REFERENCE_MARKER, LINK_REFERENCE_MARKERS, writeHeadedComment, writeUnheadedComment, type CommentHost, type KeptVerdict, type MarkedComment, type CodeReviewComment, type SendCodeReviewInput, type SentThreads, type ThreadRead, type TriageHeader, type VerdictStatus, type WrittenComment } from "@corbits/triage-contracts";

export type { BitbucketFetch };

/** The user the token acts as: its comments are Triage's, and its participant status is Triage's review. */
export type TokenUser = { id: number; slug: string };
export type BitbucketUser = () => Promise<TokenUser>;

/** A write Bitbucket refused for a reason a person can act on, such as a merge veto or reviewing one's own pull request. */
export class BitbucketRefusal extends Error {}

export const NOT_OPEN = "the pull request is not open";
const HEAD_MOVED = "the pull request has moved past the head";

const TRIAGE_BUILD_NAME = "Corbits Triage";

function send(method: string, body?: unknown): RequestInit {
  if (body === undefined) return { method };
  return { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } };
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json() as { errors?: Array<{ message?: string }> };
    return body.errors?.map((e) => e.message).filter(Boolean).join("; ") ?? "";
  } catch {
    return "";
  }
}

async function request(bb: BitbucketFetch, path: string, init?: RequestInit): Promise<Response> {
  const res = await bb(path, { ...init, headers: { accept: "application/json", ...init?.headers } });
  if (!res.ok) throw new Error(`bitbucket ${init?.method ?? "GET"} ${path} -> ${res.status} ${await errorMessage(res)}`.trimEnd());
  return res;
}

async function json(bb: BitbucketFetch, path: string, init?: RequestInit): Promise<any> {
  const res = await request(bb, path, init);
  return res.status === 204 ? null : res.json();
}

/** Bitbucket answers 400 or 409 when the write is not allowed for this pull request, with a reason worth showing. */
async function refusable(bb: BitbucketFetch, path: string, init: RequestInit): Promise<any> {
  const res = await bb(path, { ...init, headers: { accept: "application/json", ...init.headers } });
  if (res.status === 400 || res.status === 409) throw new BitbucketRefusal(await errorMessage(res) || `Bitbucket refused ${init.method} ${path}`);
  if (!res.ok) throw new Error(`bitbucket ${init.method} ${path} -> ${res.status} ${await errorMessage(res)}`.trimEnd());
  return res.status === 204 ? null : res.json();
}

function prPath(repo: string, number: number): string {
  return `${repoPath(repo)}/pull-requests/${number}`;
}

/** Data Center names the authenticated user in a response header on every request. */
export async function tokenUser(bb: BitbucketFetch): Promise<TokenUser> {
  const res = await request(bb, "/rest/api/1.0/application-properties");
  const id = Number(res.headers.get("x-auserid"));
  const name = res.headers.get("x-ausername");
  if (!id || !name) throw new Error("the Bitbucket token names no user");
  const users = await jsonAll(bb, `/rest/api/1.0/users?filter=${encodeURIComponent(name)}`);
  const user = (users as TokenUser[]).find((u) => u.id === id);
  if (!user) throw new Error(`Bitbucket user ${name} not found`);
  return { id, slug: user.slug };
}

type ParticipantStatus = "UNAPPROVED" | "NEEDS_WORK" | "APPROVED";
type Participant = { user: { id: number; slug: string }; role: string; status: ParticipantStatus };

export type PullRequest = {
  state: "OPEN" | "DECLINED" | "MERGED";
  version: number;
  sha: string;
  /** The source branch's ref id, unless it is in a fork. */
  branch: string | undefined;
  url: string;
  author: { id: number; slug: string };
  reviewers: Participant[];
  participants: Participant[];
};

export async function readPr(bb: BitbucketFetch, repo: string, number: number): Promise<PullRequest> {
  const pr = await json(bb, prPath(repo, number));
  return { state: pr.state, version: pr.version, sha: pr.fromRef.latestCommit, branch: pr.fromRef.repository.id === pr.toRef.repository.id ? pr.fromRef.id : undefined, url: pr.links.self[0].href, author: pr.author.user, reviewers: pr.reviewers, participants: pr.participants };
}

export function statusOf(pr: PullRequest, user: TokenUser): ParticipantStatus | undefined {
  return [...pr.reviewers, ...pr.participants].find((p) => p.user.id === user.id)?.status;
}

/** Bitbucket adds the token user as a participant when it sets a status; it refuses one on the user's own pull request. */
export async function setStatus(bb: BitbucketFetch, input: { repo: string; number: number; slug: string; status: ParticipantStatus }) {
  const path = `${prPath(input.repo, input.number)}/participants/${encodeURIComponent(input.slug)}`;
  const set = await refusable(bb, path, send("PUT", { status: input.status }));
  return { status: set.status as ParticipantStatus };
}

export async function addReviewers(bb: BitbucketFetch, input: { repo: string; number: number; reviewers: string[] }) {
  for (const slug of input.reviewers) {
    await refusable(bb, `${prPath(input.repo, input.number)}/participants`, send("POST", { user: { name: slug }, role: "REVIEWER" }));
  }
  return { reviewers: input.reviewers };
}

export type Comment = { id: number; version: number; text: string; author: { id: number }; updatedDate?: number };

type Activity = { action: string; commentAction?: string; comment?: Comment };

/** Top-level comments on the pull request, oldest first; Data Center lists them only through its activity stream. */
export async function listComments(bb: BitbucketFetch, repo: string, number: number): Promise<Comment[]> {
  const activities = await jsonAll(bb, `${prPath(repo, number)}/activities`) as Activity[];
  return activities.filter((a) => a.action === "COMMENTED" && a.commentAction === "ADDED" && a.comment).map((a) => a.comment!).reverse();
}

export async function createComment(bb: BitbucketFetch, input: { repo: string; number: number; text: string }) {
  const posted = await json(bb, `${prPath(input.repo, input.number)}/comments`, send("POST", { text: input.text }));
  return { commentId: posted.id as number };
}

/** An edit needs the version it read; an edit of a comment deleted since reads as undefined. */
function commentHost(bb: BitbucketFetch, repo: string, number: number, versions: Map<number, number>): CommentHost {
  return {
    async edit(id, text) {
      const path = `${prPath(repo, number)}/comments/${id}`;
      const res = await bb(path, { ...send("PUT", { text, version: versions.get(id) }), headers: { accept: "application/json", "content-type": "application/json" } });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`bitbucket PUT ${path} -> ${res.status} ${await errorMessage(res)}`.trimEnd());
      const edited = await res.json() as Comment;
      versions.set(id, edited.version);
      return edited.id;
    },
    async post(text) {
      return (await createComment(bb, { repo, number, text })).commentId;
    },
  };
}

function marked(comments: Comment[], user: TokenUser): Comment[] {
  return comments.filter((c) => c.author.id === user.id && isLinkReferenceTriageComment(c.text));
}

function markedComment(comment: Comment): MarkedComment {
  return { id: comment.id, body: comment.text, ...(comment.updatedDate && { updatedAt: new Date(comment.updatedDate).toISOString() }) };
}

/**
 * Only the token user's comments are read: an admin token could edit anyone's, and a copied marker must never decide
 * what Triage writes. Without a header the current comment is edited whatever it said before, keeping its verdict's header.
 */
async function writeTriageComment(bb: BitbucketFetch, input: { repo: string; number: number; body: string; header?: TriageHeader; branch: string | undefined; keepVerdictOn?: KeptVerdict }, user: TokenUser): Promise<WrittenComment> {
  const { repo, number, header, branch } = input;
  const own = marked(await listComments(bb, repo, number), user);
  const host = { ...commentHost(bb, repo, number, new Map(own.map((c) => [c.id, c.version]))), changesSince: (from: string, to: string) => changesSince(bb, repo, branch, from, to) };
  const comments = own.map(markedComment);
  if (header) return writeHeadedComment(host, LINK_REFERENCE_MARKERS, comments, header, input.body);
  const current = comments.filter((c) => !LINK_REFERENCE_MARKERS.isSuperseded(c.body));
  return writeUnheadedComment(host, LINK_REFERENCE_MARKERS, LINK_REFERENCE_MARKER, current, input.body, input.keepVerdictOn);
}

async function deleteTriageComments(bb: BitbucketFetch, repo: string, number: number, user: TokenUser) {
  for (const comment of marked(await listComments(bb, repo, number), user)) {
    await json(bb, `${prPath(repo, number)}/comments/${comment.id}?version=${comment.version}`, { method: "DELETE" });
  }
}

export async function declinePr(bb: BitbucketFetch, input: { repo: string; number: number; version: number }) {
  await refusable(bb, `${prPath(input.repo, input.number)}/decline?version=${input.version}`, send("POST", {}));
  return { declined: true };
}

type MergeCheck = { canMerge: boolean; conflicted: boolean; vetoes: Array<{ summaryMessage: string; detailedMessage?: string }> };

/** Why Bitbucket would refuse the merge now, from its own merge checks; undefined when it may merge. */
export async function mergeVeto(bb: BitbucketFetch, repo: string, number: number): Promise<string | undefined> {
  const check = await json(bb, `${prPath(repo, number)}/merge`) as MergeCheck;
  if (check.canMerge) return undefined;
  if (check.vetoes.length) return check.vetoes.map((v) => v.detailedMessage || v.summaryMessage).join("; ");
  return check.conflicted ? "the pull request has conflicts" : "Bitbucket will not merge the pull request";
}

export async function mergePr(bb: BitbucketFetch, input: { repo: string; number: number; version: number }) {
  const merged = await refusable(bb, `${prPath(input.repo, input.number)}/merge?version=${input.version}`, send("POST", {}));
  return { merged: merged.state === "MERGED" };
}

type Build = { state: string; key: string; description?: string | null; url?: string | null };

async function builds(bb: BitbucketFetch, sha: string): Promise<Build[]> {
  return await jsonAll(bb, `/rest/build-status/1.0/commits/${sha}`) as Build[];
}

/** The verdict as a build status on the head: Data Center has no labels, and a build status is what its pull request page shows beside the head. */
const BUILD_STATES = { success: "SUCCESSFUL", failure: "FAILED", pending: "INPROGRESS", error: "FAILED" } as const;
const BUILD_DESCRIPTION_MAX = 255;

/** Writes the verdict build status unless the head already shows it; Data Center keeps one status per key and needs a URL on it. */
async function setVerdictBuild(bb: BitbucketFetch, sha: string, status: VerdictStatus, url: string) {
  const state = BUILD_STATES[status.state];
  const description = status.description.slice(0, BUILD_DESCRIPTION_MAX);
  const current = (await builds(bb, sha)).find((b) => b.key === TRIAGE_BUILD_KEY);
  if (current && current.state === state && (current.description ?? "") === description && current.url === url) return { build: state, written: false };
  await json(bb, `/rest/build-status/1.0/commits/${sha}`, send("POST", { state, key: TRIAGE_BUILD_KEY, name: TRIAGE_BUILD_NAME, url, description }));
  return { build: state, written: true };
}

/** Data Center opens the pull request scrolled to a comment from its overview with the comment's id. */
function commentUrl(pr: PullRequest, commentId: number): string {
  return `${pr.url}/overview?commentId=${commentId}`;
}

export interface MirrorInput {
  repo: string;
  number: number;
  /** Data Center has no labels; kept so the verdict's request reads the same on either host. */
  labels: string[];
  owned?: readonly string[];
  comment?: string;
  header?: TriageHeader;
  /** The verdict's state, shown as the Corbits Triage build status linking to the comment, or to the pull request without one. */
  status?: VerdictStatus;
  /** The head the verdict was given on, which carries its status; never the head read now, which may be newer. */
  statusHead?: string;
  /** Writes nothing once the pull request has moved past this head. */
  onHead?: string;
  /** The pass's verdict and policy: a comment that already holds them for `onHead` is kept rather than written over. */
  keepVerdict?: Omit<KeptVerdict, "head">;
  /** While this is the head, which may not be approved, the token user's approval is taken back. */
  notReadyHead?: string;
  /** While this is the head, which leaves the author nothing to fix, the token user's needs-work is taken back. */
  fixedHead?: string;
}

type MirrorWrite = "comment" | "status" | "takeBack";

/** Takes back the token user's own review status when the head no longer earns it; anyone else's stays. */
async function takeBack(bb: BitbucketFetch, i: MirrorInput, pr: PullRequest, me: TokenUser): Promise<string[]> {
  const status = statusOf(pr, me);
  const stale = (status === "APPROVED" && i.notReadyHead === pr.sha) || (status === "NEEDS_WORK" && i.fixedHead === pr.sha);
  if (!stale) return [];
  await setStatus(bb, { repo: i.repo, number: i.number, slug: me.slug, status: "UNAPPROVED" });
  return [status];
}

/**
 * Writes the Triage comment, the build status on the verdict's head and takes back a review status the head no longer
 * earns. Each write stands alone: one that fails is named in `failed` and the others still run. An empty comment means
 * nothing is asked of the author, so an earlier one would be stale.
 */
export async function mirror(bb: BitbucketFetch, i: MirrorInput, user: BitbucketUser) {
  const { repo, number, status } = i;
  if (status && i.statusHead === undefined) throw new Error("a status needs the head it is for");
  if (i.keepVerdict && i.onHead === undefined) throw new Error("keepVerdict needs the head it keeps a verdict on");
  const pr = await readPr(bb, repo, number);
  if (pr.state !== "OPEN") return { commentId: null, updated: false, sha: pr.sha, skipped: NOT_OPEN };
  if (i.onHead !== undefined && i.onHead !== pr.sha) return { commentId: null, updated: false, sha: pr.sha, skipped: HEAD_MOVED };
  const failed: Partial<Record<MirrorWrite, string>> = {};
  async function attempt<T>(write: MirrorWrite, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (err) {
      failed[write] = errorText(err);
      return undefined;
    }
  }
  async function writeComment() {
    if (i.comment === "") await deleteTriageComments(bb, repo, number, await user());
    return i.comment ? await writeTriageComment(bb, { repo, number, body: i.comment, header: i.header, branch: pr.branch, ...(i.keepVerdict && { keepVerdictOn: { head: i.onHead!, ...i.keepVerdict } }) }, await user()) : null;
  }
  async function writeStatus() {
    return status && setVerdictBuild(bb, i.statusHead!, status, posted ? commentUrl(pr, posted.commentId) : pr.url);
  }
  async function writeTakeBack() {
    return i.notReadyHead === pr.sha || i.fixedHead === pr.sha ? await takeBack(bb, i, pr, await user()) : undefined;
  }
  const posted = await attempt("comment", writeComment) ?? null;
  const build = await attempt("status", writeStatus);
  const dismissed = await attempt("takeBack", writeTakeBack);
  return {
    commentId: posted?.commentId ?? null,
    updated: posted?.updated ?? false,
    sha: pr.sha,
    ...(posted?.unchanged && { unchanged: posted.unchanged }),
    ...(posted?.kept && { kept: posted.kept }),
    ...(build && { build: build.build, buildWritten: build.written }),
    ...(dismissed && { dismissed }),
    ...(Object.keys(failed).length > 0 && { failed }),
  };
}

/** The first line of each comment a code review posts: the head it was sent on, and for an inline one, which finding. */
function codeReviewMarker(sha: string, finding?: CodeReviewComment): string {
  if (finding === undefined) return `${CODE_REVIEW_MARKER}${sha}`;
  const key = createHash("sha256").update(JSON.stringify([finding.path, finding.start, finding.end, finding.title, finding.body])).digest("hex").slice(0, 12);
  return `${CODE_REVIEW_MARKER}${sha}/${key}`;
}

type DiffSegment = { type: "ADDED" | "REMOVED" | "CONTEXT"; lines: Array<{ destination: number }> };
type FileDiff = { fromHash: string; toHash: string; diffs: Array<{ hunks?: Array<{ segments: DiffSegment[] }> }> };

type Anchor = { path: string; line: number; lineType: "ADDED" | "CONTEXT"; fileType: "TO"; diffType: "EFFECTIVE"; fromHash: string; toHash: string };

/**
 * The first line of the finding the pull request's diff shows on the new side, with the type the diff gives it. Data
 * Center accepts any anchor, even a line the diff does not show, so only one taken from the diff is ever sent.
 */
function anchorOf(finding: CodeReviewComment, file: FileDiff): Anchor | undefined {
  for (const segment of file.diffs.flatMap((diff) => diff.hunks ?? []).flatMap((hunk) => hunk.segments)) {
    if (segment.type === "REMOVED") continue;
    const line = segment.lines.find((l) => l.destination >= finding.start && l.destination <= finding.end);
    if (line) return { path: finding.path, line: line.destination, lineType: segment.type, fileType: "TO", diffType: "EFFECTIVE", fromHash: file.fromHash, toHash: file.toHash };
  }
  return undefined;
}

/** The inline comment already standing for `finding` on one of `heads`, or null when there is none. */
function standing(own: Map<string, number>, heads: readonly string[], finding: CodeReviewComment): number | null {
  for (const head of heads) {
    const id = own.get(codeReviewMarker(head, finding));
    if (id !== undefined) return id;
  }
  return null;
}

/**
 * Sends a code review on `sha` as an inline comment per finding the diff shows and one summary comment holding the
 * rest, posted last. Each comment names the head and finding it is for, so a repeat posts only what is missing, and
 * nothing once the summary stands on `sha` or on the head the review was carried over from. Either way `threads` names
 * each finding's inline comment.
 */
export async function sendCodeReview(bb: BitbucketFetch, input: SendCodeReviewInput, user: BitbucketUser) {
  const { repo, number, sha, reviewed } = input;
  const me = await user();
  const own = new Map((await listComments(bb, repo, number)).filter((c) => c.author.id === me.id).map((c) => [c.text.split("\n", 1)[0]!, c.id]));
  const heads = [sha, ...(reviewed === undefined ? [] : [reviewed])];
  const summaryId = heads.map((head) => own.get(codeReviewMarker(head))).find((id) => id !== undefined);
  if (summaryId !== undefined) return { commentId: summaryId, sent: false, threads: input.comments.map((finding) => standing(own, heads, finding)) };
  if ((await readPr(bb, repo, number)).sha !== sha) return { commentId: null, sent: false, skipped: HEAD_MOVED };
  const diffs = new Map<string, FileDiff>();
  for (const path of new Set(input.comments.map((finding) => finding.path).filter(plainSegments))) {
    const file = await json(bb, `${prPath(repo, number)}/diff/${filePath(path)}?withComments=false`) as FileDiff;
    if (file.toHash !== sha) return { commentId: null, sent: false, skipped: HEAD_MOVED };
    diffs.set(path, file);
  }
  const outside: string[] = [];
  const threads: SentThreads["threads"] = [];
  for (const finding of input.comments) {
    const file = diffs.get(finding.path);
    const anchor = file === undefined ? undefined : anchorOf(finding, file);
    if (!anchor) {
      outside.push(findingSection(finding));
      threads.push(null);
      continue;
    }
    const existing = standing(own, heads, finding);
    if (existing !== null) {
      threads.push(existing);
      continue;
    }
    const text = [codeReviewMarker(sha, finding), inlineFindingText(finding, { start: anchor.line, end: anchor.line })].join("\n");
    threads.push((await json(bb, `${prPath(repo, number)}/comments`, send("POST", { text, anchor }))).id as number);
  }
  const text = [codeReviewMarker(sha), [input.summary, ...outside].filter((part) => part !== "").join("\n\n")].join("\n");
  return { commentId: (await createComment(bb, { repo, number, text })).commentId, sent: true, threads };
}

type ThreadComment = { author: { id: number }; createdDate: number; threadResolved?: boolean; threadResolvedDate?: number; anchor?: { orphaned?: boolean }; comments?: ThreadComment[] };

/** Data Center leaves `comments` out of a comment nobody replied to. */
function replies(comment: ThreadComment): ThreadComment[] {
  if (comment.comments === undefined) return [];
  return comment.comments.flatMap((reply) => [reply, ...replies(reply)]);
}

/**
 * A comment thread's state: resolved, outdated once the line it was anchored to left the diff, or replied to by someone
 * other than the comment's author, newest reply first.
 */
function threadReadOf(id: number, comment: ThreadComment): ThreadRead {
  if (comment.threadResolved === true) return { id, state: "resolved", ...(comment.threadResolvedDate !== undefined && { at: new Date(comment.threadResolvedDate).toISOString() }) };
  if (comment.anchor?.orphaned === true) return { id, state: "outdated" };
  const answers = replies(comment).filter((reply) => reply.author.id !== comment.author.id);
  if (answers.length === 0) return { id, state: "untouched" };
  return { id, state: "replied", at: new Date(Math.max(...answers.map((reply) => reply.createdDate))).toISOString() };
}

/** The state of the thread comment `id` opened, or undefined for a comment deleted since. */
async function threadAt(bb: BitbucketFetch, repo: string, number: number, id: number): Promise<ThreadRead | undefined> {
  const path = `${prPath(repo, number)}/comments/${id}`;
  const res = await bb(path, { headers: { accept: "application/json" } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`bitbucket GET ${path} -> ${res.status} ${await errorMessage(res)}`.trimEnd());
  return threadReadOf(id, await res.json() as ThreadComment);
}

/**
 * The state of the thread each comment of `ids` opened; a comment deleted since has none. A comment that could not be
 * read is named in `unread`, so one failure leaves only its own thread unread.
 */
export async function findingThreadStates(bb: BitbucketFetch, repo: string, number: number, ids: readonly number[]): Promise<{ threads: ThreadRead[]; unread?: string }> {
  const threads: ThreadRead[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    if (!Number.isSafeInteger(id)) throw new Error(`comment id must be an integer, got ${id}`);
    try {
      const read = await threadAt(bb, repo, number, id);
      if (read) threads.push(read);
    } catch (err) {
      failed.push(errorText(err));
    }
  }
  return { threads, ...(failed.length > 0 && { unread: failed.join("; ") }) };
}
