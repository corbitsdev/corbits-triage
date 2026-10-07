// Read-only pull request details for the portal's PR view (files with
// patches, commits, conversation, referenced issues). Workflow run logs keep
// only step outputs, so the view reads GitHub live with the tenant's App.
import { type } from "arktype";
import { getChecks, getPr, getReviews, listIssueComments, listPrCommits, listPrFiles, listReferencedIssues } from "@corbits/github-tool/github";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { appGithubFetch, failure, githubAppCredential, portalMember, type PortalCredentialDeps } from "./portal-credential.js";

export const GITHUB_PR_DETAILS_PATH = "/api/integrations/github-pull";

const Query = type({ repo: /^[\w.-]+\/[\w.-]+$/, number: "string.integer.parse" }).pipe((q, ctx) => (q.number > 0 ? q : ctx.error("number must be positive")));

export function createGithubPrDetails(deps: PortalCredentialDeps & { githubApiOrigin: string }) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  return async function handle(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    const url = new URL(req.url);
    const query = Query({ repo: url.searchParams.get("repo"), number: url.searchParams.get("number") });
    if (query instanceof type.errors) return failure(400, "invalid_request", query.summary);
    const appJson = await githubAppCredential(deps, principalId, tenantId, "use");
    if (appJson instanceof Response) return appJson;
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, appJson);

    try {
      const { repo, number } = query;
      const [pr, files, commits, comments] = await Promise.all([
        getPr(gh, repo, number),
        listPrFiles(gh, repo, number),
        listPrCommits(gh, repo, number),
        listIssueComments(gh, repo, number),
      ]);
      const text = [pr.title ?? "", pr.body ?? "", ...commits.map((c) => c.message)].join("\n");
      const [issues, checks, reviews] = await Promise.all([
        listReferencedIssues(gh, repo, number, text),
        getChecks(gh, repo, pr.sha),
        getReviews(gh, repo, number),
      ]);
      return Response.json({ pr, files, commits, comments, issues, checks, reviews });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "github_pr_details_failed", tenantId, repo: query.repo, number: query.number, error: message }));
      return failure(502, "github_failed", `Could not read ${query.repo}#${query.number} from GitHub: ${message}.`);
    }
  };
}
