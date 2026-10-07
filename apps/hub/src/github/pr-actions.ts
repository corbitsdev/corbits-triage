// Human-initiated pull request writes (comment, review, merge, close). The
// operator's click is the approval, so these run synchronously in the hub
// against the tenant's vaulted GitHub App credential instead of as workflows.
import { type } from "arktype";
import { createIssueComment, createReview, mergePr, mirror } from "@corbits/github-tool/github";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { appGithubFetch, failure, githubAppCredential, portalMember, type PortalCredentialDeps } from "./portal-credential.js";

export const GITHUB_PR_ACTIONS_PATH = "/api/integrations/github-actions";

const VERB = { comment: "comment on", review: "review", merge: "merge", close: "close" } as const;

const ActionBody = type({ repo: /^[\w.-]+\/[\w.-]+$/, number: "number.integer > 0" }).and(
  type({ action: "'comment'", body: "string > 0" })
    .or({ action: "'review'", event: "'APPROVE' | 'REQUEST_CHANGES'", body: "string" })
    .or({ action: "'merge'" })
    .or({ action: "'close'", labels: "string[]", comment: "string" }),
);

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
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
      const result = body.action === "comment"
        ? await createIssueComment(gh, { repo, number, body: body.body })
        : body.action === "review"
          ? await createReview(gh, { repo, number, body: body.body, event: body.event })
          : body.action === "merge"
            ? await mergePr(gh, { repo, number })
            : await mirror(gh, { repo, number, labels: body.labels, comment: body.comment, close: true });
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "github_pr_action", tenantId, principalId, action: body.action, repo, number }));
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "github_pr_action_failed", tenantId, action: body.action, repo: body.repo, number: body.number, error: message }));
      const status = /-> (\d{3})$/.exec(message)?.[1];
      return failure(502, "github_failed", `GitHub refused to ${VERB[body.action]} ${body.repo}#${body.number}${status ? ` (HTTP ${status})` : `: ${message}`}.`);
    }
  };
}
