import { errorText } from "@corbits/common";
import { failure } from "./portal-credential.js";

/** What each write does to a pull request, as it reads after "GitHub refused to". */
export const GITHUB_VERB = {
  comment: "comment on",
  reply: "reply on",
  labels: "label",
  assign: "assign",
  "request-review": "request reviewers on",
  review: "review",
  "code-review": "send the code review to",
  approve: "approve",
  "request-changes": "request changes on",
  merge: "merge",
  close: "close",
} as const;

/** A host's failure as a sentence; the transport line (method, path, status) is for logs only. */
function refusal(host: string, what: string, err: unknown): string {
  const message = errorText(err);
  const status = /(?:-> |answered )(\d{3})\b/.exec(message)?.[1];
  return `${host} refused to ${what}${status ? ` (HTTP ${status})` : `: ${message}`}.`;
}

export function githubFailed(what: string, err: unknown): Response {
  return failure(502, "github_failed", refusal("GitHub", what, err));
}

export function bitbucketFailed(what: string, err: unknown): Response {
  return failure(502, "bitbucket_failed", refusal("Bitbucket", what, err));
}
