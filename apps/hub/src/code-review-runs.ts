// A pull request's latest code review, as its manager recorded it: one still out, what one reported, or one the manager
// gave up on. A head whose diff is the one the latest review read, as after a rebase that changed no line of it, takes
// that review over instead of being reviewed again.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema, type DB } from "@intx/db";
import { CodeReviewComment, REPO_SOURCES, repoSourceOf, StageResult, type RepoSource } from "@corbits/triage-contracts";
import { asRecord } from "@corbits/common";
import { diffHash } from "@corbits/common/diff-hash";
import type { PullRequestToReview } from "./pull-request-reader.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./github/tenant-config.js";
import type { Member } from "./integrations/app.js";
import { codeReviews, type CodeReviewRecord } from "./manager-state.js";

/** Heads compared with the review before them; only a comparison made is kept, never a read that failed. */
const KEPT_CARRIES = 2_000;
/** A head whose diff could not be read is not read again for the portal sooner than this. */
const UNREAD_RETRY_MS = 5 * 60_000;

const Source = type.enumerated(...REPO_SOURCES);

/** `head` is the pull request's head as the asker last read it, which the newest finished review may stand for. */
export const CodeReviewQuery = type({ repo: "string > 0", "source?": Source, number: "string.integer.parse", "head?": "string > 0" });

const CompletedRun = type({
  status: "'completed'",
  headSha: "string",
  startedAt: "string",
  summary: "string",
  comments: CodeReviewComment.array(),
  budgetExhausted: "boolean",
  "complete?": "boolean",
  "diffHash?": "string",
});
const ReviewRun = CompletedRun.or({ status: "'running' | 'failed'", headSha: "string", startedAt: "string" });
export type CompletedReview = typeof CompletedRun.infer;
/**
 * The pull request's newest review, and its newest finished one, which is the same unless a newer one is running or
 * failed; `carriedTo` is the asked head when the finished review stands for it too.
 */
export const CodeReviewFound = type({ review: ReviewRun.or("null"), completed: CompletedRun.or("null"), carriedTo: "string | null" });
type Found = Omit<typeof CodeReviewFound.infer, "carriedTo">;

type Review = typeof ReviewRun.infer;

function prioritised(findings: unknown): unknown {
  return Array.isArray(findings) ? findings.filter((finding) => typeof asRecord(finding)?.["priority"] === "number") : findings;
}

/**
 * A stored review's result without the findings stored before every finding carried a priority, which the finder's
 * reply now drops, so an old review still shows.
 */
function withPriorities(payload: Record<string, unknown>): Record<string, unknown> {
  const result = asRecord(payload["result"]);
  if (!result) return payload;
  return { ...payload, result: { ...result, comments: prioritised(result["comments"]), ...(result["dropped"] !== undefined && { dropped: prioritised(result["dropped"]) }) } };
}

/** A code review as the portal shows it. */
function reviewOf(record: CodeReviewRecord): Review {
  const base = { headSha: record.head, startedAt: record.at };
  if (record.state === "running") return { ...base, status: "running" };
  if (record.state === "failed") return { ...base, status: "failed" };
  const reported = StageResult.assert({ ...withPriorities(record.payload), head: record.head });
  if ("failed" in reported) return { ...base, status: "failed" };
  if (reported.kind !== "code-review") throw new Error(`a code review result names ${reported.kind}`);
  const { summary, budgetExhausted, complete } = reported.result;
  const comments = reported.result.comments.map(({ path, start, end, title, body, priority, quoted, unverified }) => ({ path, start, end, title, body, priority, ...(quoted !== undefined && { quoted }), ...(unverified && { unverified }) }));
  return { ...base, status: "completed", summary, comments, budgetExhausted, ...(complete !== undefined && { complete }), ...(reported.diffHash && { diffHash: reported.diffHash }) };
}

type CodeReviewRunsDeps = {
  db: DB["db"];
  read: (tenantId: string, record: RepoRecord, number: number) => Promise<PullRequestToReview>;
  log: (entry: Record<string, unknown>) => void;
};

function keep<V>(kept: Map<string, V>, key: string, value: V, max: number): void {
  kept.set(key, value);
  const [oldest] = kept.keys();
  if (kept.size > max && oldest !== undefined) kept.delete(oldest);
}

/** The review a head other than its own could take over: the newest, finished, and with its diff's hash. */
function carriable({ review, completed }: Found, headSha: string): CompletedReview | undefined {
  if (completed === null || review !== completed || completed.headSha === headSha || completed.diffHash === undefined) return undefined;
  return completed;
}

export function createCodeReviewRuns(deps: CodeReviewRunsDeps) {
  const compared = new Map<string, boolean>();
  const unread = new Map<string, number>();

  function comparedKey(tenantId: string, source: RepoSource, repo: string, number: number, from: string, to: string): string {
    return `${tenantId}\n${source}\n${repo}\n${number}\n${from}\n${to}`;
  }

  async function tenantOf(tenantId: string) {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { domain: true, config: true } });
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    return tenant;
  }

  async function reviewsOf(tenantId: string, source: RepoSource, repo: string, number: number): Promise<Found> {
    const reviews = (await codeReviews(deps.db, tenantId, { source, repo, number })).map(reviewOf);
    return { review: reviews[0] ?? null, completed: reviews.find((review) => review.status === "completed") ?? null };
  }

  function sameDiff(tenantId: string, record: RepoRecord, number: number, completed: CompletedReview, head: Pick<PullRequestToReview, "headSha" | "diff">): boolean {
    const hash = diffHash(head.diff);
    const same = hash !== undefined && completed.diffHash === hash;
    keep(compared, comparedKey(tenantId, sourceOf(record), record.name, number, completed.headSha, head.headSha), same, KEPT_CARRIES);
    return same;
  }

  /** The pull request read for the portal, unless reading it failed or found another head within `UNREAD_RETRY_MS`. */
  async function readFor(tenantId: string, record: RepoRecord, number: number, head: string, key: string): Promise<PullRequestToReview | undefined> {
    const failedAt = unread.get(key);
    if (failedAt !== undefined && Date.now() - failedAt < UNREAD_RETRY_MS) return undefined;
    try {
      const pull = await deps.read(tenantId, record, number);
      if (pull.headSha === head) return pull;
    } catch (err) {
      deps.log({ level: "warn", msg: "code_review_carry_unread", tenantId, repo: record.name, pr: number, error: String(err) });
    }
    keep(unread, key, Date.now(), KEPT_CARRIES);
    return undefined;
  }

  /** `head`, when the pull request is at it and its diff is the one the newest finished review read. */
  async function carriedTo(tenantId: string, config: unknown, query: typeof CodeReviewQuery.infer, reviews: Found): Promise<string | null> {
    const { head, repo, number } = query;
    const source = repoSourceOf(query.source);
    const completed = head === undefined ? undefined : carriable(reviews, head);
    if (head === undefined || !completed) return null;
    const key = comparedKey(tenantId, source, repo, number, completed.headSha, head);
    const known = compared.get(key);
    if (known !== undefined) return known ? head : null;
    const record = repoRecords(triageNs(config)).find((row) => row.name === repo && sourceOf(row) === source && row.connected);
    const pull = record && (await readFor(tenantId, record, number, head, key));
    return record && pull && sameDiff(tenantId, record, number, completed, pull) ? head : null;
  }

  async function latest(tenantId: string, query: typeof CodeReviewQuery.infer): Promise<typeof CodeReviewFound.infer> {
    const tenant = await tenantOf(tenantId);
    const reviews = await reviewsOf(tenantId, repoSourceOf(query.source), query.repo, query.number);
    return { ...reviews, carriedTo: await carriedTo(tenantId, tenant.config, query, reviews) };
  }

  async function latestCodeReview(query: typeof CodeReviewQuery.infer, { tenantId }: Member): Promise<Response> {
    return Response.json(await latest(tenantId, query));
  }

  return { latest, latestCodeReview };
}

export type CodeReviewRuns = ReturnType<typeof createCodeReviewRuns>;
