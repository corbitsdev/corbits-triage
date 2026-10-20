import { type } from "arktype";

/** Shown beside a review whose reader reached its limit for reading the repository before it finished. */
export const BUDGET_EXHAUSTED_NOTE = "Stopped early: the reviewer reached its limit for reading the repository.";

/** One finding of a code review: its lines in the reviewed head, what is wrong, its priority (0 is the most severe) and the code it quotes. */
export const CodeReviewComment = type({ path: "string", start: "number", end: "number", title: "string", body: "string", "priority?": "number", "quoted?": "string" });
export type CodeReviewComment = typeof CodeReviewComment.infer;

/** A finding's title as people read it, after its priority when it has one. */
export function findingTitle({ title, priority }: Pick<CodeReviewComment, "title" | "priority">): string {
  return priority === undefined ? title : `P${priority} · ${title}`;
}

/** The bold first line of a finding's comment on the pull request. */
export function findingHeadline(finding: Pick<CodeReviewComment, "title" | "priority">): string {
  return `**${findingTitle(finding)}**`;
}

const HEADLINE = /^\*\*(?:P(\d+) · )?(.+)\*\*$/;

/** A comment's finding title and priority from its headline; a comment without one is titled by its first line. */
export function parseFindingHeadline(body: string): Pick<CodeReviewComment, "title" | "priority"> {
  const first = body.trimStart().split("\n", 1)[0]!.trim();
  const match = HEADLINE.exec(first);
  if (!match) return { title: first };
  return match[1] === undefined ? { title: match[2]! } : { title: match[2]!, priority: Number(match[1]) };
}
