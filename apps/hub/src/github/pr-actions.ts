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
  upsertTriageComment,
} from "@corbits/github-tool/github";
import { codeownersForPr, type GithubFetch } from "@corbits/github-reads";
import { ownedLabels, TRIAGE_LABELS, type ActionKind } from "@corbits/triage-contracts";
import type { CheckPackRead } from "./check-pack-store.js";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { appGithubFetch, doRefused, failure, githubAppCredential, type PortalCredentialDeps } from "./portal-credential.js";
import { GITHUB_VERB, githubFailed } from "./github-refusal.js";
import { logJson } from "./bridge.js";

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
    .or({ action: "'merge'", "headSha?": "string > 0" })
    .or({ action: "'close'", labels: "string[]", comment: "string" }),
);

/** `owned` is the labels a close takes back: triage's own and the policy's verdict labels. */
async function runAction(gh: GithubFetch, body: typeof ActionBody.infer, owned: readonly string[]) {
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
      return mirror(gh, { repo, number, labels: body.labels, owned, comment: body.comment, close: true });
  }
}

/** The Do kind whose grant a direct action needs; triage's reply is a comment. */
function doKind(body: typeof ActionBody.infer): ActionKind {
  switch (body.action) {
    case "comment":
    case "reply":
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

export function createGithubPrActions(deps: PortalCredentialDeps & { githubApiOrigin: string; readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead> }) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  return async function handle(body: typeof ActionBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    const appJson = await githubAppCredential(deps, principalId, tenantId, "use");
    if (appJson instanceof Response) return appJson;
    const refused = await doRefused(deps, principalId, tenantId, body.repo, doKind(body));
    if (refused) return refused;
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, appJson);

    try {
      const { repo, number } = body;
      const read = body.action === "close" ? await deps.readCheckPack(tenantId, repo) : undefined;
      const result = await runAction(gh, body, read?.status === "ok" ? ownedLabels(read.pack.labels) : TRIAGE_LABELS);
      if (result instanceof Response) return result;
      logJson({ level: "info", msg: "github_pr_action", tenantId, principalId, action: body.action, repo, number });
      return Response.json(result);
    } catch (err) {
      const message = errorText(err);
      logJson({ level: "warn", msg: "github_pr_action_failed", tenantId, action: body.action, repo: body.repo, number: body.number, error: message });
      return githubFailed(`${GITHUB_VERB[body.action]} ${body.repo}#${body.number}`, err);
    }
  };
}
