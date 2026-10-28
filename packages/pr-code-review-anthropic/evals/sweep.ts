// Posting threshold sweep: replays saved --e2e results with no model calls. Each final review comment gets its group's
// features from the saved step outputs (top finder confidence, finder agreement, priority), every cutoff is applied and
// what is left is scored with scoreCase, as the e2e stages are.
import { BUDGET_EXHAUSTED } from "@corbits/pr-code-review/actions/checkout";
import { orderedGroups, sameCode, type Candidate, type Consolidated } from "@corbits/pr-code-review/actions/review";
import { findingOf, firstFindingsList, type Finding } from "@corbits/pr-code-review/findings";
import type { CaseKey, Reach } from "./cases.js";
import { REACHES, scoreCase } from "./score.js";

/** A final review comment where it sits, with the features a cutoff reads. */
export interface Comment extends Finding {
  finders: number;
  /** The highest confidence any finder gave a finding in its group; absent when no finder gave one. */
  confidence?: number;
}

export interface Replayed {
  key: CaseKey;
  comments: Comment[];
}

/**
 * Comments posted when their priority is at most `priority` and their top confidence at least the cutoff for their
 * agreement: `oneFinder` for comments one finder reported, `bothFinders` for those both did. A cutoff of 0 keeps
 * comments without a confidence; Infinity drops them all. A comment without a priority posts only when `priority` is
 * Infinity.
 */
export interface Cutoff {
  oneFinder: number;
  bothFinders: number;
  priority: number;
}

export const KEEP_ALL: Cutoff = { oneFinder: 0, bothFinders: 0, priority: Number.POSITIVE_INFINITY };

export function posts(comment: Comment, cutoff: Cutoff): boolean {
  const least = comment.finders >= 2 ? cutoff.bothFinders : cutoff.oneFinder;
  const confident = least === 0 || (comment.confidence !== undefined && comment.confidence >= least);
  const severe = cutoff.priority === Number.POSITIVE_INFINITY || (comment.priority !== undefined && comment.priority <= cutoff.priority);
  return confident && severe;
}

export interface SavedOutputs {
  findDiff: { reply: string };
  findRepo: { reply: string };
  candidates: { found: Candidate[]; kept: Candidate[] };
  consolidate: { reply: string };
  check: { reply: string }[];
  writeInput: { findings: Finding[] };
  review: { comments: (Finding & { agreement: { finders: number } })[] };
}

function confidenceOf(item: Record<string, unknown>): number | undefined {
  const value = typeof item.confidence === "string" && item.confidence.trim() !== "" ? Number(item.confidence) : item.confidence;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The confidence of each finding the finder's reply yields, in the order the candidates step reads them. */
function finderConfidences(reply: string): (number | undefined)[] {
  const list = firstFindingsList(reply.replace(BUDGET_EXHAUSTED, ""));
  if (!list) {
    if (reply.startsWith(BUDGET_EXHAUSTED)) return [];
    throw new Error(`finder reply holds no findings list: ${reply.slice(0, 80)}`);
  }
  return list.flatMap((item) => (findingOf(item) === undefined ? [] : [confidenceOf(item)]));
}

/** Each kept candidate's top confidence over the found candidates folded into it, folded in found order as the candidates step does. */
function keptConfidences(outputs: SavedOutputs): (number | undefined)[] {
  const confidences = [...finderConfidences(outputs.findDiff.reply), ...finderConfidences(outputs.findRepo.reply)];
  const { found, kept } = outputs.candidates;
  if (confidences.length !== found.length) throw new Error(`the finder replies yield ${confidences.length} findings, the saved candidates ${found.length}`);
  const top: (number | undefined)[] = [];
  for (const [i, candidate] of found.entries()) {
    const folded = kept.slice(0, top.length).findIndex((k) => sameCode(k, candidate));
    const index = folded === -1 ? top.push(undefined) - 1 : folded;
    const confidence = confidences[i];
    const best = top[index];
    if (confidence !== undefined && (best === undefined || confidence > best)) top[index] = confidence;
  }
  if (top.length !== kept.length) throw new Error(`folding ${found.length} found candidates gives ${top.length} kept, the saved run ${kept.length}`);
  return top;
}

function sameFinding(a: Finding, b: Finding): boolean {
  return a.path === b.path && a.start === b.start && a.end === b.end && a.title === b.title;
}

function isReal(output: { reply: string }): boolean {
  return (JSON.parse(output.reply) as { verdict: string }).verdict === "real";
}

/** The final review's comments with their group's features, from one case's saved step outputs, matched in the order the review reports them. */
export function commentsOf(outputs: SavedOutputs): Comment[] {
  const { kept } = outputs.candidates;
  const ordered = orderedGroups(kept, JSON.parse(outputs.consolidate.reply) as Consolidated);
  // A run saved before every finding was checked has no check outputs and reported every group.
  const reported = outputs.check.length === 0 ? ordered : ordered.filter((_, i) => outputs.check[i] !== undefined && isReal(outputs.check[i]));
  const confidences = keptConfidences(outputs);
  function comment(posted: SavedOutputs["review"]["comments"][number], index: number): Comment {
    const entry = reported[index];
    const written = outputs.writeInput.findings[index];
    if (!entry || !written || !sameFinding(entry.finding, written)) throw new Error(`comment ${index} at ${posted.path}:${posted.start} does not replay as the review reported it`);
    const known = entry.group.members.flatMap((i) => (confidences[i] === undefined ? [] : [confidences[i]]));
    const { path, start, end, priority } = posted;
    return { path, start, end, ...(priority !== undefined && { priority }), finders: posted.agreement.finders, ...(known.length > 0 && { confidence: Math.max(...known) }) };
  }
  if (reported.length !== outputs.review.comments.length) throw new Error(`${reported.length} replayed findings, ${outputs.review.comments.length} comments`);
  return outputs.review.comments.map(comment);
}

export interface SweepRow {
  cutoff: Cutoff;
  comments: number;
  falseAlarms: number;
  /** Null when nothing posts. */
  precision: number | null;
  caught: number;
  bugs: number;
  recall: number;
  byReach: Record<Reach, string>;
  cleanSilent: number;
  clean: number;
  commentsPerPr: number;
  prsCommented: number;
  cases: number;
}

export function scoreCutoff(replayed: readonly Replayed[], cutoff: Cutoff): SweepRow {
  const scored = replayed.map(({ key, comments }) => {
    const posted = comments.filter((c) => posts(c, cutoff));
    return { key, posted, score: scoreCase(key, posted) };
  });
  const bugs = replayed.flatMap(({ key }) => key.bugs.map((bug) => ({ reach: bug.reach, caught: scored.some((s) => s.key === key && s.score.caught.includes(bug.id)) })));
  function reach(r: Reach): [Reach, string] {
    const ofReach = bugs.filter((bug) => bug.reach === r);
    return [r, `${ofReach.filter((bug) => bug.caught).length}/${ofReach.length}`];
  }
  const comments = scored.reduce((total, s) => total + s.posted.length, 0);
  const falseAlarms = scored.reduce((total, s) => total + s.score.falseAlarms, 0);
  const judged = comments - scored.reduce((total, s) => total + s.score.ignored, 0);
  const caught = bugs.filter((bug) => bug.caught).length;
  const clean = scored.filter((s) => s.key.kind === "clean");
  return {
    cutoff,
    comments,
    falseAlarms,
    precision: judged === 0 ? null : (judged - falseAlarms) / judged,
    caught,
    bugs: bugs.length,
    recall: caught / bugs.length,
    byReach: Object.fromEntries(REACHES.map(reach)) as Record<Reach, string>,
    cleanSilent: clean.filter((s) => !s.score.flaggedClean).length,
    clean: clean.length,
    commentsPerPr: comments / scored.length,
    prsCommented: scored.filter((s) => s.posted.length > 0).length,
    cases: scored.length,
  };
}

/** Every cutoff over the confidences the comments carry, both agreement levels and every priority. */
export function cutoffs(replayed: readonly Replayed[]): Cutoff[] {
  const seen = replayed.flatMap(({ comments }) => comments.flatMap((c) => (c.confidence === undefined ? [] : [c.confidence])));
  const confidences = [...new Set([0, ...seen])].sort((a, b) => a - b);
  const levels = [...confidences, Number.POSITIVE_INFINITY];
  const priorities = [0, 1, 2, 3, Number.POSITIVE_INFINITY];
  return levels.flatMap((oneFinder) => levels.flatMap((bothFinders) => priorities.map((priority) => ({ oneFinder, bothFinders, priority }))));
}

/** The rows no other row beats on both precision and recall, by recall. */
export function frontier(rows: readonly SweepRow[]): SweepRow[] {
  const posting = rows.filter((row) => row.precision !== null);
  function beaten(row: SweepRow): boolean {
    return posting.some((other) => other.recall >= row.recall && other.precision! >= row.precision! && (other.recall > row.recall || other.precision! > row.precision!));
  }
  const best = posting.filter((row) => !beaten(row)).sort((a, b) => a.recall - b.recall);
  return best.filter((row, i) => i === 0 || row.recall !== best[i - 1]!.recall || row.precision !== best[i - 1]!.precision);
}

/** The loosest cutoff at or above the bar: the most bugs caught, then the fewest false alarms. */
export function loosest(rows: readonly SweepRow[], bar: number): SweepRow | undefined {
  const passing = rows.filter((row) => row.precision !== null && row.precision >= bar);
  return passing.sort((a, b) => b.caught - a.caught || a.falseAlarms - b.falseAlarms)[0];
}
