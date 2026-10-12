import { reviewedOnHead, type Review } from "@corbits/github-tool";
import { authorAssociation, authorKindOf, teamSlug, tierOf, type CheckPack, type RepoPolicy, type TriageEvent } from "@corbits/triage-contracts";
import type { RulesItem } from "../actions/rules.js";
import { MAX_PATCH_INPUT_CHARS } from "./candidates.js";
import type { PrFacts, PrFileFacts } from "./checks.js";
import { isRecord } from "./extract.js";
import { MAX_SYSTEM_ONE_STATE_BYTES } from "./quality.js";

export interface PrData {
  title?: string;
  body?: string | null;
  author?: string;
  authorAssociation?: string | null;
  authorBot?: boolean;
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
  const association = authorAssociation(pr.authorAssociation);
  const authorKind = authorKindOf(association, pr.authorBot === true);
  return {
    repo,
    number,
    title: pr.title ?? "",
    author,
    ...(authorKind ? { authorKind } : {}),
    tier: tierOf(association, author, policy.approvedAuthors),
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

// Patch text past three judge requests' worth is not read, so later pages leave patches out.
export const MAX_PATCH_CHARS = 3 * MAX_SYSTEM_ONE_STATE_BYTES;

/** One page of `github_list_pr_files`, its files read as facts. */
export type FilesPage = { files: PrFileFacts[]; next?: number; patchNext?: number };

/** Where the next page of files starts, and whether it still carries patches. */
export type FilesCursor = { offset: number; patchOffset?: number; patches: boolean };

export type ListedFiles = { files: PrFileFacts[]; patchChars: number };

export const FIRST_FILES_PAGE: FilesCursor = { offset: 0, patches: true };

/**
 * Adds one page to `listed`, joining a patch continued from the previous page, and returns the next page's cursor,
 * none when every file is read, or why the pages cannot be read. A patch past the budget is left cut and marked so.
 */
export function addFilesPage(listed: ListedFiles, cursor: FilesCursor, page: FilesPage): FilesCursor | undefined | string {
  let files = page.files;
  if (cursor.patchOffset !== undefined) {
    const continued = listed.files.at(-1);
    if (!continued || files[0]?.path !== continued.path) return `github_list_pr_files did not continue the patch at offset ${cursor.offset}`;
    continued.patch = (continued.patch ?? "") + (files[0].patch ?? "");
    listed.patchChars += files[0].patch?.length ?? 0;
    files = files.slice(1);
  }
  listed.files.push(...files);
  listed.patchChars += files.reduce((chars, file) => chars + (file.patch?.length ?? 0), 0);
  const patches = listed.patchChars < MAX_PATCH_CHARS;
  if (page.next === undefined) return undefined;
  if (page.patchNext !== undefined) {
    if (page.next < cursor.offset || (page.next === cursor.offset && page.patchNext <= (cursor.patchOffset ?? 0))) return `github_list_pr_files did not advance past offset ${cursor.offset}`;
    const cut = listed.files.at(-1)!;
    if (patches && (cut.patch?.length ?? 0) < MAX_PATCH_INPUT_CHARS) return { offset: page.next, patchOffset: page.patchNext, patches };
    cut.patchTruncated = true;
    return { offset: page.next + 1, patches };
  }
  if (page.next <= cursor.offset) return `github_list_pr_files did not advance past offset ${cursor.offset}`;
  return { offset: page.next, patches };
}

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

/** Every spelling of a team the repository's roles use. */
function roleTeamSpellings(policy: RepoPolicy): string[] {
  return [...new Set(Object.values(policy.roles).flatMap((role) => role.teams ?? []))];
}

/** The distinct slugs of the repository owner's teams the roles name, which is what the membership read takes. */
export function roleTeams(policy: RepoPolicy, repo: string): string[] {
  return [...new Set(roleTeamSpellings(policy).flatMap((team) => teamSlug(team, repo) ?? []))].sort();
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

/** What GitHub returned for one pull request; `files` is why the file list could not be read, when it could not. */
export interface PullData {
  pr: PrData | null;
  checks: CheckRun[];
  reviews: Review[];
  commits: Array<{ message?: string }>;
  files: PrFileFacts[] | string;
  /** The author's membership of the roles' teams; null when it was not read or could not be. */
  authorTeams: { teams?: unknown; unknown?: unknown } | null;
}

/** Maps the read's slugs back to every spelling the roles use; a team the read did not answer, or another org's team, is unknown. */
function membership(read: PullData["authorTeams"], policy: RepoPolicy, repo: string): Pick<PrFacts, "authorTeams" | "authorTeamsUnknown"> {
  const member = strings(read?.teams);
  const unknown = strings(read?.unknown);
  const authorTeams: string[] = [];
  const authorTeamsUnknown: string[] = [];
  for (const team of roleTeamSpellings(policy)) {
    const slug = teamSlug(team, repo);
    if (slug === null || !member || !unknown || unknown.includes(slug)) authorTeamsUnknown.push(team);
    else if (member.includes(slug)) authorTeams.push(team);
  }
  return { authorTeams, authorTeamsUnknown };
}

export interface ItemContext {
  repo: string;
  openPrs: PrFacts["openPrs"];
  policy: RepoPolicy;
  pack: CheckPack;
  events: TriageEvent[];
  /** The repository's docs by path, or why they could not be read. */
  docs: Record<string, string> | string;
}

/** The rules step's item for one pull request, or the error that degrades it. */
export function assembleItem(number: number, data: PullData, { repo, openPrs, policy, pack, events, docs }: ItemContext): RulesItem {
  const { pr, files } = data;
  if (!pr) return { error: `github_get_pr failed for #${number}` };
  if (typeof files === "string") return { error: files };
  if (typeof docs === "string") return { error: docs };
  const paths = files.map((file) => file.path);
  const commits = data.commits.map(firstLine);
  const facts = { ...buildFacts(repo, number, pr, data.checks, data.reviews, openPrs, policy), paths, files, commits, events, docs, ...membership(data.authorTeams, policy, repo) };
  return { facts, pack, roles: policy.roles, cleanupMode: policy.cleanupMode };
}
