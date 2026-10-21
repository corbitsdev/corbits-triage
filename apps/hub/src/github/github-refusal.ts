import { errorText } from "@corbits/common";
import { GithubRateLimited } from "./github-usage.js";
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

/** GitHub's rate limit as a 503 whose Retry-After and `resetAt` say when it lifts; undefined for any other failure. */
export function githubLimited(err: unknown): Response | undefined {
  if (!(err instanceof GithubRateLimited)) return undefined;
  const response = failure(503, "github_rate_limited", `${err.message}.`, { resetAt: new Date(err.resetAt).toISOString() });
  response.headers.set("retry-after", String(Math.max(1, Math.ceil((err.resetAt - Date.now()) / 1000))));
  return response;
}

export function githubFailed(what: string, err: unknown): Response {
  return githubLimited(err) ?? failure(502, "github_failed", refusal("GitHub", what, err));
}

export function bitbucketFailed(what: string, err: unknown): Response {
  return failure(502, "bitbucket_failed", refusal("Bitbucket", what, err));
}
