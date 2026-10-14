// Read-only pull request details for the portal's PR view (files with
// patches, commits, conversation, referenced issues). Workflow run logs keep
// only step outputs, so the view reads the pull request's host live: GitHub
// with the tenant's App, Bitbucket Data Center with the tenant's token.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { getChecks, getPr, getReviews, listIssueComments, listPrCommits, listPrFiles, listReferencedIssues, type GithubFetch } from "@corbits/github-reads";
import { errorText } from "@corbits/common";
import type { TenantBitbucket } from "../bitbucket-datacenter/tenant-bitbucket.js";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { forInstallation } from "./open-pulls.js";
import { appGithubFetch, failure, githubAppCredential, sourceCredentialGrant, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./tenant-config.js";

export const GITHUB_PR_DETAILS_PATH = "/api/integrations/github-pull";

const Query = type({ repo: /^[\w.-]+\/[\w.-]+$/, number: "string.integer.parse" }).pipe((q, ctx) => (q.number > 0 ? q : ctx.error("number must be positive")));

async function githubDetails(gh: GithubFetch, repo: string, number: number) {
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
  return { pr, files, commits, comments, issues, checks, reviews };
}

/** Data Center lists changes without patches or line counts and has no issue tracker of its own. */
async function bitbucketDetails(bb: bitbucket.BitbucketFetch, repo: string, number: number) {
  const [pr, files, commits, comments, reviews] = await Promise.all([
    bitbucket.getPr(bb, repo, number),
    bitbucket.listPrFiles(bb, repo, number),
    bitbucket.listPrCommits(bb, repo, number),
    bitbucket.listIssueComments(bb, repo, number),
    bitbucket.getReviews(bb, repo, number),
  ]);
  const checks = await bitbucket.getChecks(bb, pr.sha);
  return { pr, files: files.map((file) => ({ ...file, additions: 0, deletions: 0 })), commits, comments, issues: [], checks, reviews };
}

export function createGithubPrDetails(deps: PortalCredentialDeps & { githubApiOrigin: string; tenantBitbucket: TenantBitbucket; log: (entry: Record<string, unknown>) => void }) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  async function detailsOf(tenantId: string, principalId: string, record: RepoRecord, number: number) {
    if (sourceOf(record) === "bitbucket-datacenter") {
      const bb = await deps.tenantBitbucket(tenantId);
      if (!bb) throw new Error("no active bitbucket-datacenter credential");
      return bitbucketDetails(bb, record.name, number);
    }
    const appJson = await githubAppCredential(deps, principalId, tenantId, "read");
    if (appJson instanceof Response) throw new Error("the GitHub App credential is not readable");
    return githubDetails(forInstallation(appGithubFetch(appFetch, deps.githubApiOrigin, appJson), record.installationId), record.name, number);
  }

  return async function handle(req: Request, { tenantId, principalId }: Member): Promise<Response> {
    const url = new URL(req.url);
    const query = Query({ repo: url.searchParams.get("repo"), number: url.searchParams.get("number") });
    if (query instanceof type.errors) return failure(400, "invalid_request", query.summary);

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === query.repo && row.connected);
    if (!record) return failure(409, "repo_not_connected", `${query.repo} is not connected to this workspace.`);
    const refused = await sourceCredentialGrant(deps, principalId, tenantId, record, "read");
    if (refused) return refused;

    try {
      return Response.json(await detailsOf(tenantId, principalId, record, query.number));
    } catch (err) {
      const message = errorText(err);
      deps.log({ level: "warn", msg: "pr_details_failed", tenantId, repo: query.repo, number: query.number, error: message });
      return failure(502, "source_failed", `Could not read ${query.repo}#${query.number} from ${sourceOf(record)}: ${message}.`);
    }
  };
}
