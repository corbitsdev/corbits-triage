import { failure } from "./portal-credential.js";

/** What each write does to a pull request, as it reads after "GitHub refused to". */
export const GITHUB_VERB = {
  comment: "comment on",
  reply: "reply on",
  labels: "label",
  assign: "assign",
  "request-review": "request reviewers on",
  review: "review",
  merge: "merge",
  close: "close",
} as const;

/** A GitHub failure as a sentence; the transport line (method, path, status) is for logs only. */
export function githubRefusal(what: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const status = /-> (\d{3})$/.exec(message)?.[1];
  return `GitHub refused to ${what}${status ? ` (HTTP ${status})` : `: ${message}`}.`;
}

export function githubFailed(what: string, err: unknown): Response {
  return failure(502, "github_failed", githubRefusal(what, err));
}
