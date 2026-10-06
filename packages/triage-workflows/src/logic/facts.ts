// SPDX-License-Identifier: GPL-2.0-only
import type { PrFacts } from "./checks.js";

export interface PrData {
  title?: string;
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
  status?: string;
  conclusion?: string | null;
}
export interface Review {
  reviewer?: string;
  state?: string;
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required"]);

export function summarizeChecks(runs: CheckRun[]): PrFacts["checks"] {
  if (!runs.length) return "none";
  if (runs.some((r) => r.conclusion && FAILED.has(r.conclusion))) return "failure";
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
    requestedReviewers: Number(pr.requestedReviewers ?? 0),
    approvals: countApprovals(reviews),
    openPrs,
    changedFiles: Number(pr.changedFiles ?? 0),
    additions: Number(pr.additions ?? 0),
    deletions: Number(pr.deletions ?? 0),
    paths: [],
  };
}
