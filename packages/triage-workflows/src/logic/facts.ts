import { authorAssociation, tierOf, type RepoPolicy } from "@corbits/triage-contracts";
import type { PrFacts } from "./checks.js";

export interface PrData {
  title?: string;
  body?: string | null;
  author?: string;
  authorAssociation?: string | null;
  sha?: string;
  branch: string;
  state?: string;
  draft?: boolean;
  mergeable?: boolean | null;
  requestedReviewers?: number;
  reviewers?: string[];
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  labels?: string[];
  assignees?: string[];
}
export interface CheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
}
export interface Review {
  reviewer?: string;
  state?: string;
  commitId?: string;
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required"]);

function failed(run: CheckRun): boolean {
  return run.conclusion !== undefined && run.conclusion !== null && FAILED.has(run.conclusion);
}

export function summarizeChecks(runs: CheckRun[]): PrFacts["checks"] {
  if (!runs.length) return "none";
  if (runs.some(failed)) return "failure";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  return "success";
}

/** Each reviewer's latest decisive review state, by login. */
function latestDecisive(reviews: Review[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.reviewer && r.state && r.state !== "COMMENTED" && r.state !== "PENDING") latest.set(r.reviewer, r.state);
  }
  return latest;
}

/** Reviewers whose latest review still stands on the current head, when the review names its commit. */
export function reviewedOnHead(reviews: Review[], headSha: string): string[] {
  const latest = new Map<string, Review>();
  for (const r of reviews) if (r.reviewer && r.state !== "PENDING") latest.set(r.reviewer, r);
  return [...latest].flatMap(([login, r]) => (r.state !== "DISMISSED" && (r.commitId === undefined || r.commitId === headSha) ? [login] : []));
}

function reviewersWith(latest: Map<string, string>, state: string): string[] {
  return [...latest].flatMap(([login, s]) => (s === state ? [login] : []));
}

export function buildFacts(
  repo: string,
  number: number,
  pr: PrData,
  checks: CheckRun[],
  reviews: Review[],
  openPrs: PrFacts["openPrs"],
  policy: RepoPolicy,
): PrFacts {
  const latest = latestDecisive(reviews);
  const author = pr.author ?? "";
  return {
    repo,
    number,
    title: pr.title ?? "",
    author,
    tier: tierOf(authorAssociation(pr.authorAssociation), author, policy.approvedAuthors),
    headSha: pr.sha ?? "",
    state: pr.state === "closed" ? "closed" : "open",
    draft: pr.draft === true,
    mergeable: pr.mergeable ?? null,
    baseBehindBy: 0,
    checks: summarizeChecks(checks),
    failingChecks: checks.filter(failed).flatMap((r) => (r.name ? [r.name] : [])),
    requestedReviewers: Number(pr.requestedReviewers ?? 0),
    reviewers: pr.reviewers ?? [],
    approvals: reviewersWith(latest, "APPROVED").length,
    changesRequested: reviewersWith(latest, "CHANGES_REQUESTED"),
    reviewedBy: reviewedOnHead(reviews, pr.sha ?? ""),
    labels: pr.labels ?? [],
    assignees: pr.assignees ?? [],
    openPrs,
    changedFiles: Number(pr.changedFiles ?? 0),
    additions: Number(pr.additions ?? 0),
    deletions: Number(pr.deletions ?? 0),
    paths: [],
    body: pr.body ?? "",
    branch: pr.branch,
  };
}
