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

/** A host's failure as a sentence with the host's own reason; the method and path are for logs only. */
function refusal(host: string, what: string, err: unknown): string {
  const message = errorText(err);
  const transport = /-> (\d{3})\b\s*(.*)$/s.exec(message);
  if (!transport) return `${host} refused to ${what}: ${message.replace(/\.$/, "")}.`;
  const [, status, reason] = transport;
  return `${host} refused to ${what} (HTTP ${status})${reason ? `: ${reason.replace(/\.$/, "")}` : ""}.`;
}

export function githubFailed(what: string, err: unknown): Response {
  return failure(502, "github_failed", refusal("GitHub", what, err));
}

export function bitbucketFailed(what: string, err: unknown): Response {
  return failure(502, "bitbucket_failed", refusal("Bitbucket", what, err));
}
