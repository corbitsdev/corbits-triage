import { type } from "arktype";

/** Shown beside a review whose reader reached its limit for reading the repository before it finished. */
export const BUDGET_EXHAUSTED_NOTE = "Stopped early: the reviewer reached its limit for reading the repository.";

/** Shown beside a review that is not complete. */
export const INCOMPLETE_NOTE = "This review did not read the whole change; approve and merge are held until a review does.";

/** Shown with a finding none of whose file's lines could be read. */
export const UNVERIFIED_FINDING = "Not checked against the file";

/** Why a merge waits on the review threads, given who opened each unresolved one; undefined when none is. */
export function threadsHold(openers: readonly string[]): string | undefined {
  if (openers.length === 0) return undefined;
  const noun = openers.length === 1 ? "thread" : "threads";
  return `Merge waits for ${openers.length} unresolved review ${noun}, opened by ${[...new Set(openers)].join(", ")}.`;
}

/** Why a merge waits when the review threads could not be read: it never goes ahead unread. */
export function threadsUnread(reason: string): string {
  return `Merge waits: Triage couldn't read the review threads (${reason}).`;
}

/**
 * What became of a finding's thread on the host:the author resolved it, the code under it changed, someone other than
 * Triage replied, or none of these yet.
 */
export const THREAD_STATES = ["resolved", "outdated", "replied", "untouched"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

/** A thread's state as the host reads it, by the id of Triage's comment; `at` is the host's time of the change, when it names one. */
export const ThreadRead = type({ id: "number", state: type.enumerated(...THREAD_STATES), "at?": "string" });
export type ThreadRead = typeof ThreadRead.infer;

/** Triage's comment for a finding posted inline, and its thread's state: untouched when posted, then as last read, since `at` when the host names it. */
export const FindingThread = type({ id: "number", state: type.enumerated(...THREAD_STATES), "at?": "string" });
export type FindingThread = typeof FindingThread.infer;

/** A finding is open until its thread is resolved on the host or the code under it changed on a later head. */
export function findingOpen(thread: FindingThread | undefined): boolean {
  return thread?.state !== "resolved" && thread?.state !== "outdated";
}

/**
 * One finding of a code review: its lines in the reviewed head, what is wrong, its priority (0 is the most severe), the
 * code it quotes, when none of its lines could be read, `unverified`, and once it is posted inline, its `thread`.
 */
export const CodeReviewComment = type({ path: "string", start: "number", end: "number", title: "string", body: "string", priority: "number", "quoted?": "string", "unverified?": "true", "thread?": FindingThread });
export type CodeReviewComment = typeof CodeReviewComment.infer;

/** A finding the review left out: its check found it not real, or could not decide and only one finder reported it. */
const CodeReviewDropped = CodeReviewComment.and({ verdict: "'not_real' | 'unsure'", reason: "string" });

/** A changed file's repository path and the ranges of its patch's lines no finder was shown, numbered through the whole patch. */
export const UnreadLines = type({ path: "string", lines: type(["number", "number"]).array() });
export type UnreadLines = typeof UnreadLines.infer;

/**
 * What a code review run answers: its summary, its findings, the findings its check dropped, whether its reader
 * stopped early, and `complete` when its finders between them were shown every line of the diff without either
 * spending its budget. A review without it, as one recorded before it was reported, is not complete. `unread` lists the
 * first 50 files with patch lines no finder was shown, in at most 20 ranges each, and `unreadFiles` counts every such
 * file; a review recorded before they were reported has neither.
 */
export const CodeReviewOutput = type({ summary: "string", comments: CodeReviewComment.array(), "dropped?": CodeReviewDropped.array(), budgetExhausted: "boolean", "complete?": "boolean", "unread?": UnreadLines.array(), "unreadFiles?": "number.integer >= 0" });
export type CodeReviewOutput = typeof CodeReviewOutput.infer;

/** The title and priority of a finding, or of a comment a review posted before every finding carried a priority. */
type Headline = { title: string; priority?: number };

/** A finding's title as people read it, after its priority when it has one. */
export function findingTitle({ title, priority }: Headline): string {
  return priority === undefined ? title : `P${priority} · ${title}`;
}

/** The bold first line of a finding's comment on the pull request. */
export function findingHeadline(finding: Headline): string {
  return `**${findingTitle(finding)}**`;
}

const HEADLINE = /^\*\*(?:P(\d+) · )?(.+)\*\*$/;

/** A comment's finding title and priority from its headline; a comment without one is titled by its first line. */
export function parseFindingHeadline(body: string): Headline {
  const first = body.trimStart().split("\n", 1)[0]!.trim();
  const match = HEADLINE.exec(first);
  if (!match) return { title: first };
  return match[1] === undefined ? { title: match[2]! } : { title: match[2]!, priority: Number(match[1]) };
}

/** The lines of a finding a host's inline comment sits on. */
export type FindingLines = { start: number; end: number };

function lineRange({ start, end }: FindingLines): string {
  return end > start ? `${start}–${end}` : `${start}`;
}

/** The finding's lines outside the comment's, named so none are lost when its range runs past what the comment covers. */
function alsoCovers(finding: CodeReviewComment, at: FindingLines): string[] {
  const before = at.start > finding.start ? [lineRange({ start: finding.start, end: at.start - 1 })] : [];
  const after = finding.end > at.end ? [lineRange({ start: at.end + 1, end: finding.end })] : [];
  const ranges = [...before, ...after];
  return ranges.length ? [`Also lines ${ranges.join(" and ")}.`] : [];
}

function unverifiedNote(finding: CodeReviewComment): string[] {
  return finding.unverified ? [`_${UNVERIFIED_FINDING}._`] : [];
}

/** An inline comment's text for a finding shown at `at`. */
export function inlineFindingText(finding: CodeReviewComment, at: FindingLines): string {
  return [findingHeadline(finding), finding.body, ...alsoCovers(finding, at), ...unverifiedNote(finding)].join("\n\n");
}

/** A finding the diff does not show, as a section of the review's summary. */
export function findingSection(finding: CodeReviewComment): string {
  return [`${findingHeadline(finding)} · \`${finding.path}:${lineRange(finding)}\``, finding.body, ...unverifiedNote(finding)].join("\n\n");
}

/**
 * A code review to send to a pull request. `sha` is the head the review read; it is sent once, and not at all once the
 * pull request has moved past it. `reviewed` is the head the review was made for when it was carried over to `sha`.
 */
export type SendCodeReviewInput = { repo: string; number: number; sha: string; reviewed?: string; summary: string; comments: CodeReviewComment[] };

/**
 * Each finding's inline comment on the host, in the order of the review's findings; null for one held in the summary.
 * `threads` is null, and `unread` says why, when the host wrote the review but its comments could not be read back.
 */
export type SentThreads = { threads: (number | null)[] | null; unread?: string };
