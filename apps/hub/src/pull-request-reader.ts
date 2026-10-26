// Reads a pull request as its host shows it, alone or with its diff, and builds the code review request a manager's
// review reads: the diff cut to the limit and hashed whole, so a later head with the same diff can take a review over
// (code-review-runs.ts).
import { createHash } from "node:crypto";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { readPr, readPrDiff, type GithubFetch } from "@corbits/github-reads";
import { shownBody, visibleText, type RepoSource } from "@corbits/triage-contracts";
import type { TenantBitbucket } from "./bitbucket-datacenter/tenant-bitbucket.js";
import { filesFrom } from "@corbits/common/diff-files";
import { forInstallation } from "./github/open-pulls.js";
import { sourceOf, type RepoRecord } from "./github/tenant-config.js";

/**
 * The most diff text one review reads, about 25k tokens, which keeps a review near its measured cost; past it the diff
 * is cut at a line boundary and the review names the files it left unread.
 */
const DIFF_LIMIT = 100_000;

/** `labels` only where the host has them. */
export type PullRequestHead = { title: string; description: string; headSha: string; draft: boolean; open: boolean; labels?: string[] };

export type PullRequestToReview = PullRequestHead & { diff: string };

/**
 * The diff's hash, its `index` lines' blob ids included, so a base change to a file the diff touches changes it; undefined
 * for a diff with no `index` line, such as one rebuilt from the file list, which can't show such a change.
 */
export function diffHash(diff: string): string | undefined {
  if (!diff.split("\n").some((line) => line.startsWith("index "))) return undefined;
  return createHash("sha256").update(diff).digest("hex");
}

function lineCount(text: string): number {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * The diff whole, or its first lines that fit in `limit`, with how many of how many lines it keeps and, when every path
 * can be read, the files it cuts part-way or leaves out.
 */
export function cutDiff(diff: string, limit = DIFF_LIMIT): { diff: string; cut?: { lines: number; of: number; unread?: string[] } } {
  if (diff.length <= limit) return { diff };
  const end = diff.lastIndexOf("\n", limit);
  const kept = end < 0 ? diff.slice(0, limit) : diff.slice(0, end + 1);
  const unread = filesFrom(diff, kept.length);
  return { diff: kept, cut: { lines: lineCount(kept), of: lineCount(diff), ...(unread && { unread }) } };
}

type PullRequestReaderDeps = {
  tenantGithub: (tenantId: string) => Promise<GithubFetch | undefined>;
  tenantBitbucket: TenantBitbucket;
};

/** The title and description as the host shows them, as triage reads them. */
function shown(pr: { title: string; body?: string | null; bodyHtml?: string | null }, source: RepoSource, name: string, number: number) {
  const description = shownBody(pr, source);
  if (description === undefined) throw new Error(`${name}#${number}: the host returned no rendered body`);
  return { title: visibleText(pr.title), description };
}

type Host = { bb: bitbucket.BitbucketFetch } | { gh: GithubFetch };

function bitbucketHead(pr: Awaited<ReturnType<typeof bitbucket.getPr>>, record: RepoRecord, number: number): PullRequestHead {
  return { ...shown(pr, "bitbucket-datacenter", record.name, number), headSha: pr.sha, draft: pr.draft, open: pr.state === "open" };
}

function githubHead(pr: Awaited<ReturnType<typeof readPr>>, record: RepoRecord, number: number): PullRequestHead {
  return { ...shown(pr, "github", record.name, number), headSha: pr.sha, draft: pr.draft === true, open: pr.state === "open", labels: pr.labels };
}

/** Reads a pull request, alone or with its diff, as the tenant's GitHub App or Bitbucket Data Center token. */
export function createPullRequestReader(deps: PullRequestReaderDeps) {
  async function hostOf(tenantId: string, record: RepoRecord): Promise<Host> {
    if (sourceOf(record) === "bitbucket-datacenter") {
      const bb = await deps.tenantBitbucket(tenantId);
      if (!bb) throw new Error(`no Bitbucket Data Center token for ${record.name}`);
      return { bb };
    }
    const app = await deps.tenantGithub(tenantId);
    if (!app) throw new Error(`no GitHub App credential for ${record.name}`);
    return { gh: forInstallation(app, record.installationId) };
  }

  return {
    async head(tenantId: string, record: RepoRecord, number: number): Promise<PullRequestHead> {
      const host = await hostOf(tenantId, record);
      if ("bb" in host) return bitbucketHead(await bitbucket.getPr(host.bb, record.name, number), record, number);
      return githubHead(await readPr(host.gh, record.name, number), record, number);
    },
    async withDiff(tenantId: string, record: RepoRecord, number: number): Promise<PullRequestToReview> {
      const host = await hostOf(tenantId, record);
      if ("bb" in host) {
        const [pr, diff] = await Promise.all([bitbucket.getPr(host.bb, record.name, number), bitbucket.readPrDiff(host.bb, record.name, number)]);
        return { ...bitbucketHead(pr, record, number), diff };
      }
      const [pr, diff] = await Promise.all([readPr(host.gh, record.name, number), readPrDiff(host.gh, record.name, number)]);
      return { ...githubHead(pr, record, number), diff };
    },
  };
}

type ReviewRequest = {
  kind: "code-review";
  number: number;
  title: string;
  description: string;
  diff: string;
  diffHash?: string;
  checkout: { source: RepoSource; repo: string; sha: string };
  cut?: ReturnType<typeof cutDiff>["cut"];
};

/** The review of the pull request as read, its diff cut to the limit and hashed whole. */
export function reviewRequestOf(record: Pick<RepoRecord, "name" | "source">, number: number, pull: PullRequestToReview): ReviewRequest {
  // A host that ignores the diff media type answers JSON, which would be reviewed as if it were the change.
  if (pull.diff !== "" && !pull.diff.startsWith("diff ")) throw new Error(`${record.name}#${number}: the host returned no unified diff`);
  const { diff, cut } = cutDiff(pull.diff);
  const hash = diffHash(pull.diff);
  return {
    kind: "code-review",
    number,
    title: pull.title,
    description: pull.description,
    diff,
    ...(hash && { diffHash: hash }),
    checkout: { source: sourceOf(record), repo: record.name, sha: pull.headSha },
    ...(cut && { cut }),
  };
}
