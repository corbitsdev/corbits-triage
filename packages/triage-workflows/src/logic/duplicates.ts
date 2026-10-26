import { isGeneratedPath } from "@corbits/triage-contracts";
import { boundedPath } from "./hunks.js";

/** The most earlier open pull requests on the base branch the duplicate rules read; past it neither checks, so one pull request's reads stay bounded. */
export const MAX_OPEN_PULLS = 100;

/** The most other open pull requests the judge is asked about, most overlap first. */
const MAX_SHORTLIST = 5;

/** The most changed paths of each the judge reads. */
const MAX_SHORTLIST_PATHS = 50;

/** Words shorter than this, such as "fix" or "the", say nothing about what a change is. */
const TITLE_WORD = /[\p{L}\p{N}]{4,}/gu;

/** Words of four or more letters that titles share whatever they change. */
const STOPWORDS = new Set(["about", "after", "also", "from", "have", "into", "more", "only", "pull", "request", "that", "them", "then", "this", "when", "with", "without"]);

/** One shared word is often chance, so a pull request that shares no path needs at least this many. */
const MIN_SHARED_WORDS = 2;

/**
 * A pull request as no-duplicate compares it: its head, the hash of its diff (null when the diff has no index lines to
 * hash) and its commits; each is absent when it was not read.
 */
export type PullPrint = { number: number; headSha?: string; diffHash?: string | null; commits?: string[] };

/** Another open pull request as the judge reads it. */
export type OpenPull = { number: number; title: string; paths: string[] };

/**
 * The open pull requests opened earlier on the same base branch, or why they were not read: `prints` of this one and of
 * those that could repeat it, and the numbers of those whose changed paths could not be read, when no-duplicate is on, and when duplicates-open-pull-request is, those that overlap it.
 */
export type OpenPulls = { unread: string } | { prints?: { self: PullPrint; others: PullPrint[]; unread: number[] }; overlapping?: OpenPull[] };

function titleWords(title: string): Set<string> {
  return new Set([...title.toLowerCase().matchAll(TITLE_WORD)].map((match) => match[0]).filter((word) => !STOPWORDS.has(word)));
}

function authored(paths: readonly string[]): string[] {
  return paths.filter((path) => !isGeneratedPath(path));
}

/**
 * The open pull requests the judge compares this one against: those sharing a changed path, or two title words of four
 * or more letters, with it, most shared paths first, then most shared words. Generated files such as lockfiles are left
 * out, since unrelated changes share them.
 */
export function overlapping(title: string, paths: readonly string[], others: readonly OpenPull[]): OpenPull[] {
  const mine = new Set(authored(paths));
  const words = titleWords(title);
  const scored = others.map(function overlap(other) {
    const theirs = authored(other.paths);
    return { other: { ...other, paths: theirs.slice(0, MAX_SHORTLIST_PATHS).map(boundedPath) }, paths: theirs.filter((path) => mine.has(path)).length, words: [...titleWords(other.title)].filter((word) => words.has(word)).length };
  });
  return scored
    .filter((row) => row.paths > 0 || row.words >= MIN_SHARED_WORDS)
    .sort((a, b) => b.paths - a.paths || b.words - a.words || a.other.number - b.other.number)
    .slice(0, MAX_SHORTLIST)
    .map((row) => row.other);
}

/**
 * Whether another pull request could have this one's diff: every path its first page of changed files lists is one this
 * changes, and, when that page lists them all, as many. Only those are read further.
 */
export function couldRepeat(paths: readonly string[], listed: readonly string[], whole: boolean): boolean {
  const mine = new Set(paths);
  return listed.length > 0 && listed.every((path) => mine.has(path)) && (!whole || new Set(listed).size === mine.size);
}

function sameCommits(a: readonly string[], b: readonly string[]): boolean {
  const shas = new Set(a);
  return shas.size > 0 && shas.size === new Set(b).size && b.every((sha) => shas.has(sha));
}

/** Compared on whatever both sides have: the same head, the same diff, or the same commits. */
function repeats(self: PullPrint, other: PullPrint): boolean {
  if (self.headSha !== undefined && other.headSha === self.headSha) return true;
  if (typeof self.diffHash === "string" && other.diffHash === self.diffHash) return true;
  return self.commits !== undefined && other.commits !== undefined && sameCommits(self.commits, other.commits);
}

function refs(numbers: readonly number[]): string {
  return numbers.map((number) => `#${number}`).join(", ");
}

/** `failed` is null when it could not be told. */
export type DuplicateResult = { failed: boolean | null; reason: string };

/**
 * Fails when an earlier open pull request has the same head, diff or commits. Another whose diff or commits could not be
 * read is compared on what was read; this pull request's own unread changes, or another's unread paths, which decide
 * whether it is compared at all, leave it unconfirmed.
 */
export function duplicateResult(read: OpenPulls | undefined): DuplicateResult {
  if (read === undefined || "unread" in read || read.prints === undefined) {
    return { failed: null, reason: `could not compare the open pull requests: ${read && "unread" in read ? read.unread : "they were not read"}` };
  }
  const { self, others, unread } = read.prints;
  const duplicates = others.filter((other) => repeats(self, other)).map((other) => other.number);
  if (duplicates.length > 0) return { failed: true, reason: `has the same changes as ${refs(duplicates)}` };
  if (others.length > 0 && self.diffHash === undefined && self.commits === undefined) return { failed: null, reason: "could not read this pull request's changes" };
  if (unread.length > 0) return { failed: null, reason: `could not read the changed paths of ${refs(unread)}` };
  return { failed: false, reason: "no earlier open pull request has the same changes" };
}
