import type { PrFacts } from "./checks.js";

export interface PrData {
  title?: string;
  body?: string | null;
  author?: string;
  sha?: string;
  state?: string;
  draft?: boolean;
  mergeable?: boolean | null;
  requestedReviewers?: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}
export interface CheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
}
export interface Review {
  reviewer?: string;
  state?: string;
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

/** Counts a reviewer's latest decisive review only. */
export function countApprovals(reviews: Review[]): number {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.reviewer && r.state && r.state !== "COMMENTED" && r.state !== "PENDING") latest.set(r.reviewer, r.state);
  }
  return [...latest.values()].filter((s) => s === "APPROVED").length;
}

export function buildFacts(
  repo: string,
  number: number,
  pr: PrData,
  checks: CheckRun[],
  reviews: Review[],
  openPrs: PrFacts["openPrs"],
): PrFacts {
  return {
    repo,
    number,
    title: pr.title ?? "",
    author: pr.author ?? "",
    headSha: pr.sha ?? "",
    state: pr.state === "closed" ? "closed" : "open",
    draft: pr.draft === true,
    mergeable: pr.mergeable ?? null,
    baseBehindBy: 0,
    checks: summarizeChecks(checks),
    failingChecks: checks.filter(failed).flatMap((r) => (r.name ? [r.name] : [])),
    requestedReviewers: Number(pr.requestedReviewers ?? 0),
    approvals: countApprovals(reviews),
    openPrs,
    changedFiles: Number(pr.changedFiles ?? 0),
    additions: Number(pr.additions ?? 0),
    deletions: Number(pr.deletions ?? 0),
    paths: [],
    body: pr.body ?? "",
  };
}
