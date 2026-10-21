// Feeds code review: each new non-draft head of a pull request in a repository with code review on is mailed to its
// host's pr-code-review once, through the same send path as triage, in a worker of its own; a head whose diff is the one
// the newest review read takes that review over instead (code-review-runs.ts).
import { createHash } from "node:crypto";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { readPr, readPrDiff, type GithubFetch } from "@corbits/github-reads";
import { shownBody, visibleText, type RepoSource } from "@corbits/triage-contracts";
import type { TenantBitbucket } from "./bitbucket-datacenter/tenant-bitbucket.js";
import { filesFrom } from "./diff-files.js";
import type { TriageJob } from "./github/coordinator.js";
import type { PrMail } from "./github/normalize.js";
import { forInstallation } from "./github/open-pulls.js";
import { CODE_REVIEW_WORKFLOWS, codeReviewWorkflowFor } from "./github/source-workflow.js";
import { sourceOf, type RepoRecord } from "./github/tenant-config.js";

const REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/**
 * The most diff text one review reads, about 25k tokens, which keeps a review near its measured cost; past it the diff
 * is cut at a line boundary and the review names the files it left unread.
 */
export const DIFF_LIMIT = 100_000;

/** Heads remembered as sent, so a webhook delivered twice is reviewed once. */
const REMEMBERED_HEADS = 10_000;

export type PullRequestToReview = { title: string; description: string; headSha: string; draft: boolean; open: boolean; diff: string };

export type CodeReviewFeedDeps = {
  /**
   * The hosts whose code review runs for `record`: a repository of the host has it on and a code review provider's key
   * is stored; none when the PR workflow reviews the repository, so a head is never reviewed twice.
   */
  reviewed: (tenantId: string, record: RepoRecord) => Promise<RepoSource[]>;
  read: (tenantId: string, record: RepoRecord, number: number) => Promise<PullRequestToReview>;
  /** Whether the head takes the pull request's newest review over, its diff being the one that review read. */
  carries: (tenantId: string, record: RepoRecord, number: number, pull: PullRequestToReview) => Promise<boolean>;
  send: (job: TriageJob) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
};

export type Offered = "sent" | "not_reviewed" | "draft" | "not_open";

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

/** Reads a pull request and its diff as the tenant's GitHub App or Bitbucket Data Center token. */
export function createPullRequestReader(deps: PullRequestReaderDeps) {
  return async function readPullRequest(tenantId: string, record: RepoRecord, number: number): Promise<PullRequestToReview> {
    const source = sourceOf(record);
    if (source === "bitbucket-datacenter") {
      const bb = await deps.tenantBitbucket(tenantId);
      if (!bb) throw new Error(`no Bitbucket Data Center token for ${record.name}`);
      const [pr, diff] = await Promise.all([bitbucket.getPr(bb, record.name, number), bitbucket.readPrDiff(bb, record.name, number)]);
      return { ...shown(pr, source, record.name, number), headSha: pr.sha, draft: pr.draft, open: pr.state === "open", diff };
    }
    const app = await deps.tenantGithub(tenantId);
    if (!app) throw new Error(`no GitHub App credential for ${record.name}`);
    const gh = forInstallation(app, record.installationId);
    const [pr, diff] = await Promise.all([readPr(gh, record.name, number), readPrDiff(gh, record.name, number)]);
    return { ...shown(pr, source, record.name, number), headSha: pr.sha, draft: pr.draft === true, open: pr.state === "open", diff };
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

export function isReviewEvent(mail: PrMail): boolean {
  return mail.event === "pull_request" && mail.action !== null && REVIEW_ACTIONS.has(mail.action) && mail.draft !== true;
}

export function createCodeReviewFeed(deps: CodeReviewFeedDeps) {
  /** Heads sent or being sent; a head is reserved before its send, so two deliveries of one push send it once. */
  const sent = new Set<string>();

  function keyOf(tenantId: string, record: Pick<RepoRecord, "name" | "source">, number: number, headSha: string): string {
    return `${tenantId}\n${sourceOf(record)}\n${record.name}\n${number}\n${headSha}`;
  }

  function reserve(key: string): boolean {
    if (sent.has(key)) return false;
    sent.add(key);
    const [oldest] = sent;
    if (sent.size > REMEMBERED_HEADS && oldest !== undefined) sent.delete(oldest);
    return true;
  }

  /** The pull request to review and its request, or why it is not reviewed. */
  async function toReview(tenantId: string, record: RepoRecord, number: number): Promise<{ pull: PullRequestToReview; request: ReviewRequest } | Exclude<Offered, "sent">> {
    if (record.codeReview !== true || !(await deps.reviewed(tenantId, record)).includes(sourceOf(record))) return "not_reviewed";
    const pull = await deps.read(tenantId, record, number);
    if (!pull.open) return "not_open";
    if (pull.draft) return "draft";
    return { pull, request: reviewRequestOf(record, number, pull) };
  }

  /** Sends the reserved head, which is let go when the send fails. */
  async function send(tenantId: string, record: RepoRecord, number: number, request: ReviewRequest, again: boolean): Promise<void> {
    const headSha = request.checkout.sha;
    try {
      await deps.send({ tenantId, workflow: codeReviewWorkflowFor(sourceOf(record)).id, repo: record.name, number, headSha, source: again ? "retry" : "event", payload: request });
    } catch (err) {
      sent.delete(keyOf(tenantId, record, number, headSha));
      throw err;
    }
    deps.log({ level: "info", msg: "code_review_sent", tenantId, repo: record.name, pr: number, headSha, again, ...(request.cut && { cut: request.cut }) });
  }

  /** A new head is sent once, unless it takes the newest review over. */
  async function review(tenantId: string, record: RepoRecord, number: number): Promise<void> {
    const found = await toReview(tenantId, record, number);
    if (typeof found === "string") return;
    const { pull, request } = found;
    if (!reserve(keyOf(tenantId, record, number, pull.headSha))) return;
    if (await deps.carries(tenantId, record, number, pull)) {
      deps.log({ level: "info", msg: "code_review_carried", tenantId, repo: record.name, pr: number, headSha: pull.headSha });
      return;
    }
    await send(tenantId, record, number, request, false);
  }

  return {
    /** A webhook's pull request event; never throws, as the webhook's own handling must not depend on it. */
    async offer(tenantId: string, record: RepoRecord, mail: PrMail): Promise<void> {
      if (mail.prNumber === null || !isReviewEvent(mail)) return;
      // Checked before reading the host, so a webhook delivered twice costs no second read.
      if (mail.headSha !== null && sent.has(keyOf(tenantId, record, mail.prNumber, mail.headSha))) return;
      try {
        await review(tenantId, record, mail.prNumber);
      } catch (err) {
        deps.log({ level: "error", msg: "code_review_send_failed", tenantId, repo: record.name, pr: mail.prNumber, error: String(err) });
      }
    },
    /** "Review again": the pull request's current head, even when it was reviewed already or took a review over. */
    async again(tenantId: string, record: RepoRecord, number: number): Promise<Offered> {
      const found = await toReview(tenantId, record, number);
      if (typeof found === "string") return found;
      reserve(keyOf(tenantId, record, number, found.pull.headSha));
      await send(tenantId, record, number, found.request, true);
      return "sent";
    },
    /** A queued review whose worker could not run, so a later event for its head sends it again. */
    forget(job: TriageJob): void {
      const host = CODE_REVIEW_WORKFLOWS.find((workflow) => workflow.id === job.workflow)?.source;
      if (host) sent.delete(keyOf(job.tenantId, { name: job.repo, source: host }, job.number, job.headSha));
    },
  };
}

export type CodeReviewFeed = ReturnType<typeof createCodeReviewFeed>;
