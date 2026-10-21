// Read-only pull request details for the portal's PR view (files with
// patches, commits, conversation, referenced issues). Workflow run logs keep
// only step outputs, so the view reads the pull request's host: GitHub with
// the tenant's App, kept until a webhook says the repository changed, and
// Bitbucket Data Center live with the tenant's token.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { appLogin, getChecks, getPr, getReviews, listIssueComments, listPrCommits, listPrFiles, listReferencedIssues, readMergeStates, type GithubFetch, type ReviewDecision } from "@corbits/github-reads";
import { errorText } from "@corbits/common";
import { shownBody, visibleText } from "@corbits/triage-contracts";
import { githubLimited } from "./github-refusal.js";
import { GithubRateLimited } from "./github-usage.js";
import { failure, sourceCredentialGrant } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import type { RepoReads } from "./repo-reads.js";
import { createSourceFetch, type SourceFetchDeps } from "./source-fetch.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./tenant-config.js";

export const GITHUB_PR_DETAILS_PATH = "/api/integrations/github-pull";

const Query = type({ repo: /^[\w.-]+\/[\w.-]+$/, number: "string.integer.parse" }).pipe((q, ctx) => (q.number > 0 ? q : ctx.error("number must be positive")));

type Log = (entry: Record<string, unknown>) => void;

/**
 * Only a blocked merge asks whether a review is what blocks it; a decision GitHub will not give leaves the block
 * unexplained, not the details unread. GitHub's rate limit fails the read like any other part of it.
 */
async function reviewDecisionOf(gh: GithubFetch, repo: string, number: number, log: Log): Promise<ReviewDecision | null> {
  try {
    const [state] = await readMergeStates(gh, repo, [number]);
    return state?.reviewDecision ?? null;
  } catch (err) {
    if (err instanceof GithubRateLimited) throw err;
    log({ level: "warn", msg: "review_decision_failed", repo, number, error: errorText(err) });
    return null;
  }
}

async function githubDetails(gh: GithubFetch, repo: string, number: number, log: Log) {
  const [pr, files, commits, comments] = await Promise.all([
    getPr(gh, repo, number),
    listPrFiles(gh, repo, number),
    listPrCommits(gh, repo, number),
    listIssueComments(gh, repo, number),
  ]);
  const body = shownBody(pr, "github");
  if (body === undefined) throw new Error("GitHub returned no rendered body");
  // Referenced issues are found only in text a reader sees, as triage reads it.
  const text = [visibleText(pr.title ?? ""), body, ...commits.map((c) => visibleText(c.message))].join("\n");
  const [issues, checks, reviews, reviewDecision] = await Promise.all([
    listReferencedIssues(gh, repo, number, text),
    getChecks(gh, repo, pr.sha),
    getReviews(gh, repo, number, function login() {
      return appLogin(gh);
    }),
    pr.mergeableState === "blocked" ? reviewDecisionOf(gh, repo, number, log) : null,
  ]);
  return { pr: { ...pr, shownBody: body, reviewDecision }, files, commits, comments, issues, checks, reviews };
}

/**
 * GitHub works mergeability out after a change without a webhook saying it is done, so open details still missing it, or
 * a block without the review decision that explains it, are read again.
 */
function mergeabilityKnown({ pr }: Awaited<ReturnType<typeof githubDetails>>): boolean {
  if (pr.state !== "open") return true;
  return pr.mergeable !== null && (pr.mergeableState !== "blocked" || pr.reviewDecision !== null);
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
  return { pr: { ...pr, shownBody: visibleText(pr.body ?? "") }, files: files.map((file) => ({ ...file, additions: 0, deletions: 0 })), commits, comments, issues: [], checks, reviews };
}

export function createGithubPrDetails(deps: SourceFetchDeps & { reads: RepoReads; log: Log }) {
  const sourceFetch = createSourceFetch(deps);

  async function detailsOf(tenantId: string, principalId: string, record: RepoRecord, number: number) {
    const source = await sourceFetch(tenantId, principalId, record);
    if (!source) throw new Error(`no readable ${sourceOf(record)} credential`);
    if ("bb" in source) return bitbucketDetails(source.bb, record.name, number);
    const { gh } = source;
    return deps.reads.read({ scope: "all", tenantId, repo: record.name, key: `details:${number}`, usable: mergeabilityKnown }, function readNow() {
      return githubDetails(gh, record.name, number, deps.log);
    });
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
      return githubLimited(err) ?? failure(502, "source_failed", `Could not read ${query.repo}#${query.number} from ${sourceOf(record)}: ${message}.`);
    }
  };
}
