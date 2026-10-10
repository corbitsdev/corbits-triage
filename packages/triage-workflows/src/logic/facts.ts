import { authorAssociation, tierOf, type CheckPack, type RepoPolicy, type TriageEvent } from "@corbits/triage-contracts";
import type { RulesItem } from "../actions/rules.js";
import type { PrFacts, PrFileFacts } from "./checks.js";
import { isRecord } from "./extract.js";
import { MAX_SYSTEM_ONE_REQUEST_CONTENT_BYTES } from "./quality.js";

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

// Patch text past what one System One request can carry is never evaluated, so later pages leave patches out.
export const MAX_PATCH_CHARS = MAX_SYSTEM_ONE_REQUEST_CONTENT_BYTES;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

export function fileFacts(value: unknown): PrFileFacts[] {
  if (!isRecord(value)) return [];
  const path = optionalString(value.path) ?? optionalString(value.filename);
  if (path === undefined) return [];
  const previousPath = optionalString(value.previousPath) ?? optionalString(value.previous_filename);
  const status = optionalString(value.status);
  const additions = optionalCount(value.additions);
  const deletions = optionalCount(value.deletions);
  const patch = typeof value.patch === "string" ? value.patch : undefined;
  return [{
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
    ...(status === undefined ? {} : { status }),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
    ...(patch === undefined ? {} : { patch }),
    ...(value.patchTruncated === true ? { patchTruncated: true as const } : {}),
  }];
}

function firstLine(commit: { message?: string }): string {
  return (commit.message ?? "").split("\n", 1)[0]!;
}

/** What GitHub returned for one pull request; `files` is why the file list could not be read, when it could not. */
export interface PullData {
  pr: PrData | null;
  checks: CheckRun[];
  reviews: Review[];
  commits: Array<{ message?: string }>;
  files: PrFileFacts[] | string;
}

export interface ItemContext {
  repo: string;
  openPrs: PrFacts["openPrs"];
  policy: RepoPolicy;
  pack: CheckPack;
  events: TriageEvent[];
}

/** The rules step's item for one pull request, or the error that degrades it. */
export function assembleItem(number: number, data: PullData, { repo, openPrs, policy, pack, events }: ItemContext): RulesItem {
  const { pr, files } = data;
  if (!pr) return { error: `github_get_pr failed for #${number}` };
  if (typeof files === "string") return { error: files };
  const paths = files.map((file) => file.path);
  const commits = data.commits.map(firstLine);
  const facts = { ...buildFacts(repo, number, pr, data.checks, data.reviews, openPrs, policy), paths, files, commits, events };
  return { facts, pack, roles: policy.roles, cleanupMode: policy.cleanupMode };
}
