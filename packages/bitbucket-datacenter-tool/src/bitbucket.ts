import { jsonAll, repoPath, TRIAGE_BUILD_KEY, type BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { isLinkReferenceTriageComment, LINK_REFERENCE_MARKER, LINK_REFERENCE_MARKERS, upsertMarked, writeHeadedComment, type CommentHost, type MarkedComment, type TriageHeader, type WrittenComment } from "@corbits/triage-contracts";

export type { BitbucketFetch };

/** The user the token acts as: its comments are Triage's, and its participant status is Triage's review. */
export type TokenUser = { id: number; slug: string };
export type BitbucketUser = () => Promise<TokenUser>;

/** A write Bitbucket refused for a reason a person can act on, such as a merge veto or reviewing one's own pull request. */
export class BitbucketRefusal extends Error {}

export const NOT_OPEN = "the pull request is not open";

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
  url: string;
  author: { id: number; slug: string };
  reviewers: Participant[];
  participants: Participant[];
};

export async function readPr(bb: BitbucketFetch, repo: string, number: number): Promise<PullRequest> {
  const pr = await json(bb, prPath(repo, number));
  return { state: pr.state, version: pr.version, sha: pr.fromRef.latestCommit, url: pr.links.self[0].href, author: pr.author.user, reviewers: pr.reviewers, participants: pr.participants };
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
 * what Triage writes. Without a header the current comment is edited whatever it said before.
 */
async function writeTriageComment(bb: BitbucketFetch, input: { repo: string; number: number; body: string; header?: TriageHeader }, user: TokenUser): Promise<WrittenComment> {
  const { repo, number, header } = input;
  const own = marked(await listComments(bb, repo, number), user);
  const host = commentHost(bb, repo, number, new Map(own.map((c) => [c.id, c.version])));
  const comments = own.map(markedComment);
  if (header) return writeHeadedComment(host, LINK_REFERENCE_MARKERS, comments, header, input.body);
  const current = comments.filter((c) => !LINK_REFERENCE_MARKERS.isSuperseded(c.body));
  return upsertMarked(host, `${LINK_REFERENCE_MARKER}\n${input.body}`, current);
}

async function deleteTriageComments(bb: BitbucketFetch, repo: string, number: number, user: TokenUser) {
  for (const comment of marked(await listComments(bb, repo, number), user)) {
    await json(bb, `${prPath(repo, number)}/comments/${comment.id}?version=${comment.version}`, { method: "DELETE" });
  }
}

async function declinePr(bb: BitbucketFetch, input: { repo: string; number: number; version: number }) {
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
type VerdictBuild = { state: "SUCCESSFUL" | "FAILED" | "INPROGRESS"; description: string; url?: string };

/** Writes the verdict build status unless the head already shows it; Data Center keeps one status per key and needs a URL on it. */
async function setVerdictBuild(bb: BitbucketFetch, sha: string, build: VerdictBuild, fallbackUrl: string): Promise<{ build: VerdictBuild["state"]; written: boolean }> {
  const url = build.url ?? fallbackUrl;
  const current = (await builds(bb, sha)).find((b) => b.key === TRIAGE_BUILD_KEY);
  if (current && current.state === build.state && (current.description ?? "") === build.description && current.url === url) return { build: build.state, written: false };
  await json(bb, `/rest/build-status/1.0/commits/${sha}`, send("POST", { state: build.state, key: TRIAGE_BUILD_KEY, name: TRIAGE_BUILD_NAME, url, description: build.description }));
  return { build: build.state, written: true };
}

export interface MirrorInput {
  repo: string;
  number: number;
  /** Data Center has no labels; kept so the verdict's request reads the same on either host. */
  labels: string[];
  owned?: readonly string[];
  comment?: string;
  header?: TriageHeader;
  build?: VerdictBuild;
  close: boolean;
}

/** Writes the Triage comment and build status, and declines when asked. An empty comment means nothing is asked of the author, so an earlier one would be stale. */
export async function mirror(bb: BitbucketFetch, i: MirrorInput, user: BitbucketUser) {
  const { repo, number } = i;
  const pr = await readPr(bb, repo, number);
  if (pr.state !== "OPEN") return { commentId: null, updated: false, closed: false, sha: pr.sha, skipped: NOT_OPEN };
  if (i.comment === "") await deleteTriageComments(bb, repo, number, await user());
  const posted = i.comment ? await writeTriageComment(bb, { repo, number, body: i.comment, header: i.header }, await user()) : null;
  const build = i.build ? await setVerdictBuild(bb, pr.sha, i.build, pr.url) : undefined;
  if (i.close) await declinePr(bb, { repo, number, version: pr.version });
  return { commentId: posted?.commentId ?? null, updated: posted?.updated ?? false, closed: i.close, sha: pr.sha, ...(posted?.unchanged && { unchanged: posted.unchanged }), ...(build && { build: build.build, buildWritten: build.written }) };
}
