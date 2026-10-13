// Read-only pull request details for the portal's PR view (files with
// patches, commits, conversation, referenced issues). Workflow run logs keep
// only step outputs, so the view reads GitHub live with the tenant's App.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { getChecks, getPr, getReviews, listIssueComments, listPrCommits, listPrFiles, listReferencedIssues } from "@corbits/github-reads";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { forInstallation } from "./open-pulls.js";
import { appGithubFetch, failure, githubAppCredential, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { repoRecords, triageNs } from "./tenant-config.js";

export const GITHUB_PR_DETAILS_PATH = "/api/integrations/github-pull";

const Query = type({ repo: /^[\w.-]+\/[\w.-]+$/, number: "string.integer.parse" }).pipe((q, ctx) => (q.number > 0 ? q : ctx.error("number must be positive")));

export function createGithubPrDetails(deps: PortalCredentialDeps & { githubApiOrigin: string }) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  return async function handle(req: Request, { tenantId, principalId }: Member): Promise<Response> {
    const url = new URL(req.url);
    const query = Query({ repo: url.searchParams.get("repo"), number: url.searchParams.get("number") });
    if (query instanceof type.errors) return failure(400, "invalid_request", query.summary);
    const appJson = await githubAppCredential(deps, principalId, tenantId, "read");
    if (appJson instanceof Response) return appJson;

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === query.repo && row.connected);
    if (!record) return failure(409, "repo_not_connected", `${query.repo} is not connected to this workspace.`);
    const gh = forInstallation(appGithubFetch(appFetch, deps.githubApiOrigin, appJson), record.installationId);

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
