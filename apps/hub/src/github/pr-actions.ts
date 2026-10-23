// Human-initiated pull request writes. The operator's click is the approval, so
// these run synchronously in the hub against the tenant's vaulted GitHub App
// credential instead of as workflows.
import { type, type Traversal } from "arktype";
import { errorText } from "@corbits/common";
import type { Member } from "../integrations/app.js";
import {
  addAssignees,
  addLabels,
  createIssueComment,
  createReview,
  mergePr,
  mirror,
  requestReviewers,
  sendCodeReview,
  upsertTriageComment,
} from "@corbits/github-tool/github";
import { codeownersForPr, type GithubFetch } from "@corbits/github-reads";
import { BUDGET_EXHAUSTED_NOTE, notReviewedNote, ownedLabels, SOME_NOT_REVIEWED_NOTE, TRIAGE_LABELS, type ActionKind, type SendCodeReviewInput } from "@corbits/triage-contracts";
import { inlineCode } from "@corbits/triage-workflows/logic/render";
import type { CodeReviewRuns, CompletedReview } from "../code-review-runs.js";
import type { PolicyReader } from "./check-pack-store.js";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { appGithubFetch, doRefused, failure, githubAppCredential, type PortalCredentialDeps } from "./portal-credential.js";
import { GITHUB_VERB, githubFailed } from "./github-refusal.js";
import { tenantConfigOf } from "./bridge.js";
import { forInstallation } from "./open-pulls.js";
import type { RepoReads } from "./repo-reads.js";
import { repoRecords, sourceOf, triageNs } from "./tenant-config.js";

export const GITHUB_PR_ACTIONS_PATH = "/api/integrations/github-actions";

const handle = type("string.trim").to("string > 0");

function namesReviewers(body: { codeowners?: true; reviewers?: string[]; teamReviewers?: string[] }, ctx: Traversal) {
  const named = (body.reviewers?.length ?? 0) + (body.teamReviewers?.length ?? 0);
  return (body.codeowners ? named === 0 : named > 0) || ctx.reject("either codeowners or at least one reviewer or team");
}

export const ActionBody = type({ repo: /^[\w.-]+\/[\w.-]+$/, number: "number.integer > 0" }).and(
  type({ action: "'comment'", body: "string > 0" })
    .or({ action: "'reply'", body: "string > 0" })
    .or({ action: "'labels'", labels: "string[] > 0" })
    .or({ action: "'assign'", assignees: handle.array().atLeastLength(1) })
    .or(type({
      action: "'request-review'",
      "codeowners?": "true",
      "reviewers?": handle.array(),
      "teamReviewers?": handle.array(),
    }).narrow(namesReviewers))
    .or({ action: "'review'", event: "'REQUEST_CHANGES'", body: "string" })
    .or({ action: "'review'", event: "'APPROVE'", body: "string", headSha: "string > 0" })
    .or({ action: "'code-review'", headSha: "string > 0" })
    .or({ action: "'merge'", "headSha?": "string > 0" })
    .or({ action: "'close'", labels: "string[]", comment: "string" }),
);

type SendBody = Extract<typeof ActionBody.infer, { action: "code-review" }>;
type CodeReviewSendBody = { repo: string; number: number; headSha: string };

/** Unread files listed in a posted review; the rest are counted. */
const POSTED_UNREAD = 20;

function cutNotes({ cut }: CompletedReview): string[] {
  if (!cut) return [];
  if (!cut.unread) return [SOME_NOT_REVIEWED_NOTE];
  const listed = cut.unread.slice(0, POSTED_UNREAD).map((path) => `- ${inlineCode(path)}`);
  const more = cut.unread.length > POSTED_UNREAD ? [`- and ${cut.unread.length - POSTED_UNREAD} more`] : [];
  return [[notReviewedNote(cut.unread.length), ...listed, ...more].join("\n")];
}

/** The fixed lines added to a posted review after the model's summary, one per condition. */
function postedNotes(run: CompletedReview): string[] {
  return [...(run.budgetExhausted ? [BUDGET_EXHAUSTED_NOTE] : []), ...cutNotes(run)];
}

/** A host's send of a code review; `skipped` means the pull request moved past the head, so nothing was written. */
export type CodeReviewSender = (input: SendCodeReviewInput) => Promise<{ sent: boolean } | { skipped: string }>;

/**
 * Sends the pull request's newest finished code review at the head the person saw, only when the review is of that head,
 * or was carried over to it, and has something to post; once sent on either head it is not sent again.
 */
export async function sendReview(send: CodeReviewSender, body: CodeReviewSendBody, completed: CompletedReview | null, carriedTo: string | null) {
  const { repo, number, headSha } = body;
  if (!completed) return failure(409, "no_code_review", "This pull request has no finished code review to send.");
  if (completed.headSha !== headSha && carriedTo !== headSha) return failure(409, "code_review_outdated", "A newer code review replaced this one. Reload, then send it.");
  const notes = postedNotes(completed);
  if (!completed.summary && completed.comments.length === 0 && notes.length === 0) return failure(409, "code_review_empty", "This code review has nothing to post.");
  const sent = await send({ repo, number, sha: headSha, reviewed: completed.headSha, summary: [completed.summary, ...notes].filter(Boolean).join("\n\n"), comments: completed.comments });
  if ("skipped" in sent) return failure(409, "head_moved", "The pull request has new commits since this review. Review again, then send it.");
  return sent;
}

/** `owned` is the labels a close takes back: triage's own and the policy's verdict labels. */
async function runAction(gh: GithubFetch, login: string, body: Exclude<typeof ActionBody.infer, SendBody>, owned: readonly string[]) {
  const { repo, number } = body;
  switch (body.action) {
    case "comment":
      return createIssueComment(gh, { repo, number, body: body.body });
    case "reply":
      return upsertTriageComment(gh, { repo, number, body: body.body });
    case "labels":
      return addLabels(gh, { repo, number, labels: body.labels });
    case "assign":
      return addAssignees(gh, { repo, number, assignees: body.assignees });
    case "request-review": {
      if (!body.codeowners) return requestReviewers(gh, { repo, number, reviewers: body.reviewers, teamReviewers: body.teamReviewers });
      const owners = await codeownersForPr(gh, repo, number);
      if (owners.users.length + owners.teams.length === 0) return failure(400, "no_codeowners", "no code owners for the changed files");
      return requestReviewers(gh, { repo, number, reviewers: owners.users, teamReviewers: owners.teams });
    }
    case "review":
      return createReview(gh, { repo, number, body: body.body, event: body.event, ...("headSha" in body ? { commitId: body.headSha } : {}) });
    case "merge":
      return mergePr(gh, { repo, number, ...(body.headSha ? { sha: body.headSha } : {}) });
    case "close":
      return mirror(gh, { repo, number, labels: body.labels, owned, comment: body.comment, close: true }, login);
  }
}

/** The Do kind whose grant a direct action needs; triage's reply and a code review are comments. */
function doKind(body: typeof ActionBody.infer): ActionKind {
  switch (body.action) {
    case "comment":
    case "reply":
    case "code-review":
      return "comment";
    case "labels":
    case "assign":
    case "request-review":
    case "close":
    case "merge":
      return body.action;
    case "review":
      return body.event === "APPROVE" ? "approve" : "request-changes";
  }
}

export function createGithubPrActions(deps: PortalCredentialDeps & {
  githubApiOrigin: string;
  readCheckPack: PolicyReader;
  codeReviews: Pick<CodeReviewRuns, "latest">;
  /** The portal reads the pull request again right after its own write, before GitHub's webhook for it may arrive. */
  changed: RepoReads["changed"];
  log: (entry: Record<string, unknown>) => void;
}) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  async function ownedBy(tenantId: string, body: { action: string; repo: string }): Promise<readonly string[]> {
    if (body.action !== "close") return TRIAGE_LABELS;
    const read = await deps.readCheckPack(tenantId, body.repo, "github");
    return read.status === "ok" ? ownedLabels(read.pack.labels) : TRIAGE_LABELS;
  }

  async function act(gh: GithubFetch, login: string, tenantId: string, body: typeof ActionBody.infer) {
    if (body.action === "code-review") {
      const { completed, carriedTo } = await deps.codeReviews.latest(tenantId, { repo: body.repo, number: body.number, head: body.headSha });
      return sendReview(function sendToGithub(input) {
        return sendCodeReview(gh, input, login);
      }, body, completed, carriedTo);
    }
    return runAction(gh, login, body, await ownedBy(tenantId, body));
  }

  return async function handle(body: typeof ActionBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    const app = await githubAppCredential(deps, principalId, tenantId, "use");
    if (app instanceof Response) return app;
    const refused = await doRefused(deps, principalId, tenantId, body.repo, doKind(body));
    if (refused) return refused;
    const record = repoRecords(triageNs(await tenantConfigOf(deps, tenantId))).find((row) => row.name === body.repo && sourceOf(row) === "github");
    const gh = forInstallation(appGithubFetch(appFetch, deps.githubApiOrigin, app.appJson), record?.installationId);

    try {
      const { repo, number } = body;
      const result = await act(gh, app.login, tenantId, body);
      if (result instanceof Response) return result;
      deps.changed(tenantId, repo);
      deps.log({ level: "info", msg: "github_pr_action", tenantId, principalId, action: body.action, repo, number });
      return Response.json(result);
    } catch (err) {
      const message = errorText(err);
      deps.log({ level: "warn", msg: "github_pr_action_failed", tenantId, action: body.action, repo: body.repo, number: body.number, error: message });
      return githubFailed(`${GITHUB_VERB[body.action]} ${body.repo}#${body.number}`, err);
    }
  };
}
