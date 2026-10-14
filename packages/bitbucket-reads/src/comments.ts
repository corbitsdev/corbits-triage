import { scope, type } from "arktype";
import type { IssueComment } from "@corbits/github-reads";
import { isoTime, jsonAll, repoPath, type BitbucketFetch } from "./client.js";
import { isBot } from "./shapes.js";

const { comment: Comment } = scope({
  comment: { id: "number", text: "string", author: { slug: "string", "type?": "string" }, createdDate: "number", "comments?": "comment[]" },
}).export();

type Comment = typeof Comment.infer;

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
