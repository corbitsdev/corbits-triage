import { type } from "arktype";

/** One finding of a code review: its lines in the reviewed head, what is wrong, its priority (0 is the most severe) and the code it quotes. */
export const CodeReviewComment = type({ path: "string", start: "number", end: "number", title: "string", body: "string", "priority?": "number", "quoted?": "string" });
export type CodeReviewComment = typeof CodeReviewComment.infer;
