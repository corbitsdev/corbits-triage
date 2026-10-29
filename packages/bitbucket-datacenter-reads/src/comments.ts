import { scope, type } from "arktype";
import { errorText } from "@corbits/common";
import type { IssueComment } from "@corbits/github-reads";
import { isLinkReferenceTriageComment, threadsHold, threadsUnread } from "@corbits/triage-contracts";
import { isoTime, jsonAll, PAGE_LIMIT, repoPath, type BitbucketFetch } from "./client.js";
import { isBot } from "./shapes.js";

const { comment: Comment } = scope({
  comment: { id: "number", text: "string", author: { slug: "string", "type?": "string" }, createdDate: "number", "comments?": "comment[]", "threadResolved?": "boolean", "anchor?": { "orphaned?": "boolean" } },
}).export();

type Comment = typeof Comment.infer;

export const isTriageComment = isLinkReferenceTriageComment;

const Activity = type({ action: "string", "comment?": Comment });

function thread(comment: Comment): Comment[] {
  return [comment, ...(comment.comments ?? []).flatMap(thread)];
}

function issueComment(comment: Comment): IssueComment {
  return { id: comment.id, author: comment.author.slug, bot: isBot(comment.author), body: comment.text, createdAt: isoTime(comment.createdDate) };
}

/** Replies live only inside their root comment's activity, and a deleted comment's activity goes with it. Oldest first, as on GitHub. */
export async function listIssueComments(bb: BitbucketFetch, repo: string, number: number): Promise<IssueComment[]> {
  const activities = (await jsonAll(bb, `${repoPath(repo)}/pull-requests/${number}/activities`)).map((row) => Activity.assert(row));
  const comments = activities.flatMap((activity) => (activity.action === "COMMENTED" && activity.comment ? thread(activity.comment) : []));
  const unique = [...new Map(comments.map((comment) => [comment.id, comment])).values()];
  return unique.sort((a, b) => a.createdDate - b.createdDate).map(issueComment);
}

/** Pages of activities read at most; a pull request with more is not read at all. */
const THREAD_PAGES = 20;

/** An inline comment thread still open: a review thread, as GitHub has them, whose line is still in the diff. */
function unresolved(comment: Comment): boolean {
  return comment.anchor !== undefined && comment.anchor.orphaned !== true && comment.threadResolved !== true;
}

/**
 * Why a merge waits on the review threads: an inline comment thread neither resolved nor orphaned, or threads that
 * could not be read. A general comment is not a review thread, as on GitHub, so Triage's own verdict never holds it.
 */
export async function unresolvedThreadsHold(bb: BitbucketFetch, repo: string, number: number): Promise<string | undefined> {
  try {
    const activities = (await jsonAll(bb, `${repoPath(repo)}/pull-requests/${number}/activities`, PAGE_LIMIT, THREAD_PAGES, true)).map((row) => Activity.assert(row));
    const roots = new Map(activities.flatMap((activity) => (activity.action === "COMMENTED" && activity.comment ? [[activity.comment.id, activity.comment] as const] : [])));
    return threadsHold([...roots.values()].filter(unresolved).map((comment) => comment.author.slug));
  } catch (err) {
    return threadsUnread(errorText(err));
  }
}
