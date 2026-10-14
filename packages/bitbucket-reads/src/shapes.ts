import { type } from "arktype";

export const User = type({ slug: "string", "type?": "string" });

export type User = typeof User.infer;

/** Access-token users are SERVICE users, the Data Center equivalent of a GitHub bot. */
export function isBot(user: User): boolean {
  return user.type === "SERVICE";
}

const Ref = type({ id: "string", displayId: "string", latestCommit: "string", repository: { id: "number" } });

export const Participant = type({ user: User, role: "string", status: "string", "lastReviewedCommit?": "string" });

export const PullRequest = type({
  id: "number",
  title: "string",
  "description?": "string",
  state: "'OPEN' | 'DECLINED' | 'MERGED'",
  "draft?": "boolean",
  createdDate: "number",
  updatedDate: "number",
  fromRef: Ref,
  toRef: Ref,
  author: Participant,
  reviewers: Participant.array(),
});

export type PullRequest = typeof PullRequest.infer;
