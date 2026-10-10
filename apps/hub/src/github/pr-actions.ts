// Human-initiated pull request writes. The operator's click is the approval, so
// these run synchronously in the hub against the tenant's vaulted GitHub App
// credential instead of as workflows.
import { type, type Traversal } from "arktype";
import {
  addAssignees,
  addLabels,
  codeownersForPr,
  createIssueComment,
  createReview,
  mergePr,
  mirror,
  requestReviewers,
  upsertTriageComment,
  type GithubFetch,
} from "@corbits/github-tool/github";
import { TRIAGE_LABELS } from "@corbits/rule-packs";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { appGithubFetch, failure, githubAppCredential, portalMember, type PortalCredentialDeps } from "./portal-credential.js";
import { GITHUB_VERB, githubFailed } from "./github-refusal.js";
import { readJson } from "../read-json.js";

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
    .or({ action: "'review'", event: "'APPROVE' | 'REQUEST_CHANGES'", body: "string" })
    .or({ action: "'merge'" })
    .or({ action: "'close'", labels: "string[]", comment: "string" }),
);

async function runAction(gh: GithubFetch, body: typeof ActionBody.infer) {
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
      return createReview(gh, { repo, number, body: body.body, event: body.event });
    case "merge":
      return mergePr(gh, { repo, number });
    case "close":
      return mirror(gh, { repo, number, labels: body.labels, owned: TRIAGE_LABELS, comment: body.comment, close: true });
  }
}

export function createGithubPrActions(deps: PortalCredentialDeps & { githubApiOrigin: string }) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  return async function handle(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    const body = ActionBody(await readJson(req));
    if (body instanceof type.errors) return failure(400, "invalid_request", body.summary);
    const appJson = await githubAppCredential(deps, principalId, tenantId, "use");
    if (appJson instanceof Response) return appJson;
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, appJson);

    try {
      const { repo, number } = body;
      const result = await runAction(gh, body);
      if (result instanceof Response) return result;
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "github_pr_action", tenantId, principalId, action: body.action, repo, number }));
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "github_pr_action_failed", tenantId, action: body.action, repo: body.repo, number: body.number, error: message }));
      return githubFailed(`${GITHUB_VERB[body.action]} ${body.repo}#${body.number}`, err);
    }
  };
}
