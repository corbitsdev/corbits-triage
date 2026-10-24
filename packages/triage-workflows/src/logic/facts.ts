import { checkCancelled, checkFailed, checkPending, latestDecisive, listPrFilesPage, readPrTemplates, reviewedOnHead, summarizeChecks, type CheckRun, type GithubFetch, type IssueComment, type Review } from "@corbits/github-reads";
import { authorAssociation, authorKindOf, catalogCheckEnabled, policyTeams, shownBody, teamSlug, tierOf, visibleText, type CheckPack, type RepoPolicy, type RepoSource, type TriageEvent } from "@corbits/triage-contracts";
import type { RulesItem } from "../actions/rules.js";
import { hiddenIn, hiddenMarkup, nothingRemoved, writtenDescription } from "./hidden-content.js";
import { MAX_PATCH_INPUT_CHARS } from "./hunks.js";
import type { PrFacts, PrFileFacts } from "./checks.js";
import { isRecord } from "@corbits/common";
import { MAX_SYSTEM_ONE_STATE_BYTES } from "./quality.js";

export type RepoDocs = Pick<PrFacts, "docs" | "rules">;

export interface PrData {
  title?: string;
  body?: string | null;
  /** GitHub's rendering of the body; Bitbucket Data Center has none. */
  bodyHtml?: string | null;
  author?: string;
  authorAssociation?: string | null;
  authorBot?: boolean;
  sha?: string;
  branch: string;
  state?: string;
  draft?: boolean;
  mergeable?: boolean | null;
  reviewers?: string[];
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  labels?: string[];
  assignees?: string[];
}
export type { CheckRun };

function checkNames(runs: CheckRun[]): string[] {
  return runs.flatMap((r) => (r.name ? [r.name] : []));
}

function reviewersWith(latest: Map<string, string>, state: string): string[] {
  return [...latest].flatMap(([login, s]) => (s === state ? [login] : []));
}

function reviewAnswered(reviews: Review[], comments: IssueComment[], author: string, headSha: string, requested: string[]): boolean {
  const asked = reviews.filter((r) => r.state === "CHANGES_REQUESTED" && !r.triageRequest && r.reviewer !== undefined && requested.includes(r.reviewer) && r.submittedAt);
  const newest = asked.reduce<Review | undefined>((latest, r) => (latest === undefined || r.submittedAt! > latest.submittedAt! ? r : latest), undefined);
  if (newest === undefined) return false;
  if (newest.commitId !== undefined && newest.commitId !== headSha) return true;
  const since = newest.submittedAt!;
  return comments.some((c) => !c.bot && c.author === author && c.createdAt > since) ||
    reviews.some((r) => r.reviewer === author && r.submittedAt !== undefined && r.submittedAt > since);
}

export function buildFacts(
  repo: string,
  number: number,
  pr: PrData,
  checks: CheckRun[],
  reviews: Review[],
  comments: IssueComment[],
  policy: RepoPolicy,
): Omit<PrFacts, keyof ItemFacts | "rawBody"> {
  const latest = latestDecisive(reviews);
  const author = pr.author ?? "";
  const changesRequested = reviewersWith(latest, "CHANGES_REQUESTED");
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
    checks: summarizeChecks(checks),
    failingChecks: checkNames(checks.filter(checkFailed)),
    pendingChecks: checkNames(checks.filter(checkPending)),
    cancelledChecks: checkNames(checks.filter(checkCancelled)),
    reviewers: pr.reviewers ?? [],
    approvals: reviewersWith(latest, "APPROVED").length,
    changesRequested,
    triageRequested: reviews.some((r) => r.triageRequest && r.state === "CHANGES_REQUESTED"),
    reviewAnswered: reviewAnswered(reviews, comments, author, pr.sha ?? "", changesRequested),
    reviewedBy: reviewedOnHead(reviews, pr.sha ?? ""),
    labels: pr.labels ?? [],
    assignees: pr.assignees ?? [],
    changedFiles: Number(pr.changedFiles ?? 0),
    additions: Number(pr.additions ?? 0),
    deletions: Number(pr.deletions ?? 0),
    body: pr.body ?? "",
    branch: pr.branch,
  };
}

// Patch text past three judge requests' worth is not read, so later pages leave patches out.
const MAX_PATCH_CHARS = 3 * MAX_SYSTEM_ONE_STATE_BYTES;

export type FilesPage = { files: PrFileFacts[]; next?: number; patchNext?: number };

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

/** Every changed file of a pull request, read page by page as the facts director reads them. */
export async function listFiles(gh: GithubFetch, repo: string, number: number): Promise<PrFileFacts[]> {
  const listed: ListedFiles = { files: [], patchChars: 0 };
  let cursor: FilesCursor | undefined = FIRST_FILES_PAGE;
  while (cursor !== undefined) {
    const page = await listPrFilesPage(gh, repo, number, cursor);
    const next = addFilesPage(listed, cursor, { ...page, files: page.files.flatMap(fileFacts) });
    if (typeof next === "string") throw new Error(`${next} for #${number}`);
    cursor = next;
  }
  return listed.files;
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

/** Text rules read the first this many commit messages in full. */
const COMMIT_MESSAGES_MAX = 100;

function firstLine(message: string): string {
  return message.split("\n", 1)[0]!;
}

export function namedTeams(pack: CheckPack, repo: string): string[] {
  return [...new Set(policyTeams(pack).flatMap((team) => teamSlug(team, repo) ?? []))].sort();
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

/** What GitHub returned for one pull request; `files` is why the file list could not be read, when it could not. */
export interface PullData {
  pr: PrData | null;
  checks: CheckRun[];
  reviews: Review[];
  comments: IssueComment[];
  commits: Array<{ message?: string }>;
  files: PrFileFacts[] | string;
  authorTeams: { teams?: unknown; unknown?: unknown } | null;
  /** Unread when the pack does not ask focused. */
  stack?: { includes?: unknown; onto?: unknown } | null;
  /** Read only when regression risk is on. */
  fixes?: PrFacts["fixes"];
}

/** Maps the read's slugs back to every spelling the steps use; a team the read did not answer, or another org's team, is unknown. */
function membership(read: PullData["authorTeams"], pack: CheckPack, repo: string): Pick<PrFacts, "authorTeams" | "authorTeamsUnknown"> {
  const member = strings(read?.teams);
  const unknown = strings(read?.unknown);
  const authorTeams: string[] = [];
  const authorTeamsUnknown: string[] = [];
  for (const team of policyTeams(pack)) {
    const slug = teamSlug(team, repo);
    if (slug === null || !member || !unknown || unknown.includes(slug)) authorTeamsUnknown.push(team);
    else if (member.includes(slug)) authorTeams.push(team);
  }
  return { authorTeams, authorTeamsUnknown };
}

/** Set only on a stacked branch. */
function stackOf(read: PullData["stack"]): Pick<PrFacts, "stack"> {
  const includes = Array.isArray(read?.includes) ? read.includes.filter((number): number is number => optionalCount(number) !== undefined) : [];
  const onto = optionalCount(read?.onto);
  if (includes.length === 0 && onto === undefined) return {};
  return { stack: onto === undefined ? { includes } : { includes, onto } };
}

type ItemFacts = Pick<PrFacts, "paths" | "files" | "commits" | "commitMessages" | "events" | "docs" | "rules" | "authorTeams" | "authorTeamsUnknown" | "stack" | "hidden" | "fixes">;

export interface ItemContext {
  repo: string;
  policy: RepoPolicy;
  pack: CheckPack;
  events: TriageEvent[];
  docs: RepoDocs | string;
  /** The repository's pull request templates, whose comments are the maintainers', not the author's. */
  templates: string[] | string;
  source: RepoSource;
}

/** A GitHub repository's pull request templates, read only when the hidden-content rule tells their comments apart. */
export async function templatesFor(gh: GithubFetch, repo: string, pack: CheckPack): Promise<string[]> {
  return catalogCheckEnabled(pack, "hidden-content") ? readPrTemplates(gh, repo) : [];
}

/** `text` as a reader sees it, noting in `hidden` what it hid; `where` names the place from its shown text. */
function shownText(text: string, hidden: string[], where: (shown: string) => string): string {
  const removed = nothingRemoved();
  const shown = visibleText(text, removed);
  hidden.push(...hiddenIn(where(shown), removed));
  return shown;
}

function pathPlace(path: string): string {
  return `path ${path}`;
}

/** Patches are left as the host sent them; hunks.ts makes them safe to read. */
function shownFile(file: PrFileFacts, hidden: string[]): PrFileFacts {
  return { ...file, path: shownText(file.path, hidden, pathPlace), ...(file.previousPath === undefined ? {} : { previousPath: shownText(file.previousPath, hidden, pathPlace) }) };
}

/** The description as a reader sees it, noting in `hidden` what it hid; on GitHub its markdown hides comments. */
function shownDescription(pr: PrData, source: RepoSource, templates: string[], hidden: string[]): string | undefined {
  const removed = nothingRemoved();
  const body = shownBody(pr, source, removed);
  if (body === undefined) return undefined;
  const markup = source === "github" ? hiddenMarkup(pr.body ?? "", body, templates) : [];
  hidden.push(...new Set([...hiddenIn("description", removed), ...markup.map((what) => `description: ${what}`)]));
  return body;
}

/** The judge and the comment read pull request text only as a reader sees it; a contains text rule also reads the description as written. */
export function assembleItem(number: number, data: PullData, { repo, policy, pack, events, docs, templates, source }: ItemContext): RulesItem {
  const { pr } = data;
  if (!pr) return { error: `github_get_pr failed for #${number}` };
  if (typeof data.files === "string") return { error: data.files };
  if (typeof docs === "string") return { error: docs };
  if (typeof templates === "string") return { error: templates };
  const hidden: string[] = [];
  const title = shownText(pr.title ?? "", hidden, () => "title");
  const body = shownDescription(pr, source, templates, hidden);
  if (body === undefined) return { error: `github_get_pr returned no rendered body for #${number}` };
  const messages = data.commits.map((commit, at) => shownText(commit.message ?? "", hidden, () => `commit ${at + 1}`));
  const files = data.files.map((file) => shownFile(file, hidden));
  const paths = files.map((file) => file.path);
  const commits = messages.map(firstLine);
  const commitMessages = messages.slice(0, COMMIT_MESSAGES_MAX);
  const shown = { ...pr, title, body };
  const facts: PrFacts = { ...buildFacts(repo, number, shown, data.checks, data.reviews, data.comments, policy), rawBody: writtenDescription(pr.body ?? "", templates), paths, files, commits, commitMessages, events, hidden, ...docs, ...membership(data.authorTeams, pack, repo), ...stackOf(data.stack), ...(data.fixes && { fixes: data.fixes }) };
  return { facts, pack };
}
