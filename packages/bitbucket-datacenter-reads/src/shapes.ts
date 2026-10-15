import { type } from "arktype";

/** A branch as `branches/default` answers it. */
export const BranchHead = type({ latestCommit: "string" });

export const User = type({ slug: "string", "type?": "string" });

export type User = typeof User.infer;

/** Access-token users are SERVICE users, the Data Center equivalent of a GitHub bot. */
export function isBot(user: User): boolean {
  return user.type === "SERVICE";
}

/** One entry of a pull request's activity stream, newest first. */
export const Activity = type({ action: "string", createdDate: "number", user: User });

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
  /** Set once the pull request is merged or declined; older instances leave it out. */
  "closedDate?": "number",
  fromRef: Ref,
  toRef: Ref,
  /** The pull request's page on the instance; a recorded shape trimmed for tests may leave it out. */
  "links?": { self: type({ href: "string" }).array() },
  author: Participant,
  reviewers: Participant.array(),
  /** Anyone else who approved or marked needs work without being asked, Triage's own token user included. */
  "participants?": Participant.array(),
});

export type PullRequest = typeof PullRequest.infer;
