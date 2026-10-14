import { citationOf, citationUrl, itemText, NO_CHANGES_REQUESTED, NOT_A_DRAFT, render, TRIAGE_LABELS, VERDICT_LABELS, type ActionKind, type CheckItem, type CheckOutput, type CustomCheck, type PolicySource, type Rendered, type RepoSource, type TriageHeader, type VerdictWord, type WorkflowState } from "@corbits/triage-contracts";
import { isRecord } from "@corbits/common";
import { Decision } from "@corbits/system-one";
import { type } from "arktype";
import type { SuggestedAction } from "./actions.js";
import { hardFailures, hasModelChecks, REVIEW_ANSWERED_REASON, type CheckResult, type DeterministicResult } from "./checks.js";
import type { Judged } from "./item.js";
import { asText } from "./extract.js";
import { actionText, askedQuestionIds, DOCS_CHOICES, failureText, FOCUSED_CHOICES, isScoped, passText, SLICE_CHOICES, VERDICT_CHOICES, type FilePlan, type FocusedPlan, type QualityPlan, type VerdictChoice } from "./quality.js";

type ModelAnswer = Decision;

export interface ParsedAnswers {
  decisions: Record<string, ModelAnswer>;
  malformed: boolean;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** The adapter emits one JSON decision object per delta, concatenated in the reply. */
function decisionObjects(text: string): Record<string, unknown>[] | null {
  const decisions: Record<string, unknown>[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] ?? "")) cursor++;
    if (cursor >= text.length) break;
    if (text[cursor] !== "{") return null;
    const start = cursor;
    let depth = 0;
    let inString = false;
    for (; cursor < text.length; cursor++) {
      const character = text[cursor];
      if (inString) {
        if (character === "\\") cursor++;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) break;
    }
    if (depth !== 0 || cursor >= text.length) return null;
    try {
      const value = JSON.parse(text.slice(start, cursor + 1));
      if (!isRecord(value)) return null;
      decisions.push(value);
    } catch {
      return null;
    }
    cursor++;
  }
  return decisions;
}

/**
 * A reply is parsed on its own, without its questions, by System One's own decision shape: a choice's options are
 * whatever its probabilities name, and a score's levels whatever its legend names. Each rule checks its options or
 * levels when it reads the answer.
 */
function parseDecision(value: Record<string, unknown>): { id: string; answer: ModelAnswer } | null {
  const decision = Decision(value);
  if (decision instanceof type.errors) return null;
  return { id: decision.id, answer: decision };
}

/** The model may echo a level with other spacing or case. */
function levelName(level: string): string {
  return level.trim().toLowerCase();
}

function levelsOver(answer: ModelAnswer | undefined, levels: readonly string[]): Record<string, number> | undefined {
  if (answer?.type !== "score" || Math.abs(Object.values(answer.probabilities).reduce((total, value) => total + value, 0) - 1) > SUM_TOLERANCE) return undefined;
  const byName = new Map(Object.entries(answer.legend).map(([key, level]) => [levelName(level), answer.probabilities[key]]));
  if (byName.size !== levels.length || !levels.every((level) => byName.get(levelName(level)) !== undefined)) return undefined;
  return Object.fromEntries(levels.map((level) => [level, byName.get(levelName(level))!]));
}

// The backend rounds each probability to two places; System One's client checks sums at this tolerance but does not export it.
const SUM_TOLERANCE = 0.02;

/** Probabilities sum to about 1. */
export function choiceOver<T extends string>(answer: ModelAnswer | undefined, options: readonly T[]): Record<T, number> | undefined {
  if (answer?.type !== "choice" || !exactKeys(answer.probabilities, [...options])) return undefined;
  const sum = Object.values(answer.probabilities).reduce((total, value) => total + value, 0);
  return Math.abs(sum - 1) <= SUM_TOLERANCE ? (answer.probabilities as Record<T, number>) : undefined;
}

/** The first of equals. */
function likeliest(probabilities: Record<string, number>, keys: string[]): string {
  return keys.reduce((best, key) => (probabilities[key]! > probabilities[best]! ? key : best));
}

export function parseAnswers(reply: unknown): ParsedAnswers {
  const rows = decisionObjects(asText(reply));
  const decisions: Record<string, ModelAnswer> = {};
  if (rows === null) return { decisions, malformed: true };
  for (const row of rows) {
    const parsed = parseDecision(row);
    if (parsed === null || parsed.id in decisions) return { decisions: {}, malformed: true };
    decisions[parsed.id] = parsed.answer;
  }
  return { decisions, malformed: false };
}

export interface RenderInput {
  author: string;
  repo: string;
  headSha: string;
  det: DeterministicResult;
  answers?: ParsedAnswers | Record<string, number> | null;
  plan?: QualityPlan;
  focused?: FocusedPlan;
  judgeError?: string;
  judgeLimitExceeded?: true;
  judgeSkipped?: true;
  reviewers?: string[];
  choice?: Record<VerdictChoice, number>;
  /** Why the verdict question could not be asked: the pull request is too large for it. */
  choiceRefused?: string;
}

export type Actor = "author" | "maintainer" | "system";

export const MAX_MIRROR_COMMENT_BYTES = 60_000;

export const NEEDS_JUDGE_REASON = "needs the judge";

/** A model check the verdict did not need the decision model for. */
export const NOT_ASKED_REASON = "not asked";

const UNAVAILABLE_REASON = "decision model unavailable";

/** The decision model answered, but not decisively, or could not read every file it needed. */
const UNDECIDED_REASON = "not enough evidence to decide";

/** A file or hunk scoped check with no changed lines in scope to ask about. */
const NOT_APPLICABLE_REASON = "does not apply";

/** Files or hunks the judge never saw: GitHub left out their patch, or no request could hold them. */
const UNREAD_REASON = "file could not be read";

const NOT_APPLICABLE: CheckOutput = { kind: "not-applicable" };

export interface RenderOutput extends Rendered {
  mirror: boolean;
  labels: string[];
  verdict: VerdictWord;
  score: number | null;
  reasons: string[];
  degraded: "inference-outage" | "error" | null;
  checks: CheckResult[];
  reason: string;
  nextAction: string;
  actor: Actor;
  feedback: string;
}

type Sources = DeterministicResult["sources"];

interface Step {
  actor: Actor;
  action: string;
}

const ACTOR_ORDER: Actor[] = ["author", "maintainer", "system"];
const MAX_ACTIONS = 2;
// Jev's yes/no answers are calibrated probabilities: decide only well clear of a coin flip, otherwise leave it unsure.
const YES = 0.7;
const NO = 0.3;
// A focused slice serves the pull request's purpose, or is a separate change, only when that option holds this much probability.
const FOCUSED_DECIDES = 0.6;
// The verdict passes or fails only when that choice holds this much probability; anything less is unsure.
const VERDICT_DECIDES = 0.7;
const MAX_FILE_EVIDENCE = 3;
const MAX_CODE_CHARS = 200;

function sides(answer: ModelAnswer | undefined): { serves: number; separate: number } | undefined {
  const whole = choiceOver(answer, FOCUSED_CHOICES);
  if (whole) return { serves: whole.one_thing, separate: whole.more_than_one_thing };
  const slice = choiceOver(answer, SLICE_CHOICES);
  return slice && { serves: slice.serves_purpose, separate: slice.separate_change };
}

/** Malformed replies, or answers to questions that were not asked, are not trusted, so none of the answers count. */
function isInvalid({ decisions, malformed }: ParsedAnswers, expected: Set<string>): boolean {
  return malformed || Object.keys(decisions).some((id) => !expected.has(id));
}

export function separateSlices(answers: ParsedAnswers, focused: FocusedPlan, expected: Set<string>): string[] {
  if (isInvalid(answers, expected)) return [];
  return Object.keys(focused.slices).filter(function separate(id) {
    const answer = answers.decisions[id];
    return (sides(answer)?.separate ?? 0) >= FOCUSED_DECIDES;
  });
}

/** An answer clear of the unsure band: the verdict it drives would not change were it asked again. A custom rule's choice or level is, when one option or level holds the band's yes edge. */
function isDecisive(answer: ModelAnswer): boolean {
  if (answer.type === "noul") return answer.noul >= YES || answer.noul <= NO;
  const verdict = choiceOver(answer, VERDICT_CHOICES);
  if (verdict) return verdict.pass >= VERDICT_DECIDES || verdict.fail >= VERDICT_DECIDES;
  const focused = sides(answer);
  if (focused) return focused.serves >= FOCUSED_DECIDES || focused.separate >= FOCUSED_DECIDES;
  const docs = choiceOver(answer, DOCS_CHOICES);
  if (docs) return docs.unaffected >= YES || docs.unaffected <= NO;
  return Math.max(...Object.values(answer.probabilities)) >= YES;
}

/** A later run may reuse it. */
export function isReusableReply(reply: string): boolean {
  const { decisions, malformed } = parseAnswers(reply);
  return !malformed && Object.values(decisions).every(isDecisive);
}

// The score, out of 100, at which a model check's answer passes: the band's yes edge, or focused's deciding probability.
const PASS_AT = Math.round(YES * 100);
const FOCUSED_PASS_AT = Math.round(FOCUSED_DECIDES * 100);

type ModelEvaluation = {
  checks: CheckResult[];
  unanswered: boolean;
};

function answerSet(answers: RenderInput["answers"]): ParsedAnswers {
  if (answers && "decisions" in answers && "malformed" in answers) return answers as ParsedAnswers;
  const decisions: Record<string, ModelAnswer> = {};
  for (const [id, value] of Object.entries(answers ?? {})) {
    if (!probability(value)) return { decisions: {}, malformed: true };
    decisions[id] = { id, type: "noul", noul: value };
  }
  return { decisions, malformed: false };
}

type Decided = { result: "pass" | "fail" } | { result: "unconfirmed"; reason: string };

/** A yes/no answer on the unsure band: yes passes, no fails, anything between is not decided. */
function band(noul: number, yesPasses: boolean): Decided {
  if (noul >= YES) return { result: yesPasses ? "pass" : "fail" };
  if (noul <= NO) return { result: yesPasses ? "fail" : "pass" };
  return { result: "unconfirmed", reason: UNDECIDED_REASON };
}

export function evaluateModel({ det, answers, plan = {}, focused, judgeError, judgeLimitExceeded, judgeSkipped }: RenderInput): ModelEvaluation {
  if (!det.sources) return { checks: [], unanswered: false };
  const sources = det.sources;
  // A failed chunk leaves only its own questions unanswered; the other chunks' answers still count.
  const parsed = answerSet(det.needsJudgment ? answers : null);
  const unavailable = !det.needsJudgment ? NOT_ASKED_REASON : judgeSkipped ? NEEDS_JUDGE_REASON : judgeLimitExceeded ? judgeError! : UNAVAILABLE_REASON;
  const invalid = isInvalid(parsed, askedQuestionIds(sources, plan, focused));
  const checks: CheckResult[] = [];
  let anyUnanswered = false;

  function noulOf(id: string): number | undefined {
    const answer = invalid ? undefined : parsed.decisions[id];
    if (answer?.type === "noul") return answer.noul;
    // Docs' Choice reads as yes, the file needs docs, by how unlikely `unaffected` is.
    const docs = choiceOver(answer, DOCS_CHOICES);
    return docs && 1 - docs.unaffected;
  }

  function push(check: string, decided: Decided, output: CheckOutput, evidence: string[] = [], reason?: string) {
    checks.push(decided.result === "unconfirmed"
      ? { check, kind: "model", result: "unconfirmed", reason: decided.reason, evidence: [], output }
      : { check, kind: "model", result: decided.result, reason: reason ?? (decided.result === "fail" ? failureText(check, sources) : passText(check, sources)), evidence, output });
  }

  function unchecked(check: string, reason: string) {
    push(check, { result: "unconfirmed", reason }, { kind: "could-not-check", reason });
  }

  /** How likely the check is fine, out of 100 and unrounded, so the score clears `passAt` exactly when the answer passes. */
  function scored(fine: number, passAt: number, items: CheckItem[]): CheckOutput {
    return { kind: "score", score: Math.min(fine * 100, 100), passAt, items };
  }

  /**
   * Docs passes on a changed doc file and its questions are answered yes when a file needs docs; a
   * scoped custom check's are answered yes when the item meets its rule. Either fails naming the items that fall short,
   * which any answered item can show, and passes only when every item in scope was read and clears the bar.
   */
  function fileCheck(check: string, filePlan: FilePlan | undefined, yesPasses: boolean) {
    if (!filePlan) return unchecked(check, unavailable);
    if (filePlan.changed.length > 0) {
      const changed = filePlan.changed.slice(0, MAX_FILE_EVIDENCE);
      return push(check, { result: "pass" }, { kind: "met", items: changed }, changed);
    }
    if (!det.needsJudgment || judgeLimitExceeded) return unchecked(check, unavailable);
    if (yesPasses && Object.keys(filePlan.asked).length === 0 && filePlan.unread.length === 0) return push(check, { result: "pass" }, NOT_APPLICABLE, [], NOT_APPLICABLE_REASON);
    const answered: Array<[CheckItem, number]> = [];
    for (const [id, item] of Object.entries(filePlan.asked)) {
      const noul = noulOf(id);
      // Read as how likely the item falls short, whichever way its question is put.
      if (noul !== undefined) answered.push([item, yesPasses ? 1 - noul : noul]);
    }
    const unanswered = answered.length < Object.keys(filePlan.asked).length;
    anyUnanswered ||= unanswered;
    const needing = answered.filter(([, short]) => short >= YES).sort((a, b) => b[1] - a[1]);
    if (needing.length > 0) {
      const named = needing.slice(0, MAX_FILE_EVIDENCE).map(([item]) => item);
      return push(check, { result: "fail" }, scored(1 - needing[0]![1], PASS_AT, named), named.map(itemText));
    }
    if (unanswered) return unchecked(check, unavailable);
    // A file the judge could not read may need one, so only a fully read pull request passes.
    if (filePlan.unread.length > 0) {
      return push(check, { result: "unconfirmed", reason: UNDECIDED_REASON }, { kind: "could-not-check", reason: UNREAD_REASON, items: filePlan.unread });
    }
    if (answered.length === 0) return push(check, { result: "pass" }, NOT_APPLICABLE);
    const weakest = answered.reduce((a, b) => (b[1] > a[1] ? b : a));
    const decided = band(weakest[1], false);
    return push(check, decided, scored(1 - weakest[1], PASS_AT, [weakest[0]]));
  }

  /**
   * Focused asks each request-sized slice of the diff whether it serves the pull request's purpose: any separate slice fails
   * it, every serving slice passes it, and with no lines to read it does not apply. A failure names the files
   * most likely to be the separate change, from the follow-up file questions. The score is the least serving slice's.
   */
  function focusedCheck(plan: FocusedPlan | undefined) {
    if (!plan) return push("focused", { result: "pass" }, NOT_APPLICABLE, [], NOT_APPLICABLE_REASON);
    const answered = Object.keys(plan.slices).flatMap((id) => {
      const side = sides(invalid ? undefined : parsed.decisions[id]);
      return side ? [side] : [];
    });
    const separate = Math.max(...answered.map((side) => side.separate), 0);
    const serves = Math.min(...answered.map((side) => side.serves), 1);
    const unread = plan.unread.length > 0 ? { unread: plan.unread } : {};
    if (separate >= FOCUSED_DECIDES) {
      const likely = Object.entries(plan.parts).flatMap(([id, item]): Array<[CheckItem, number]> => {
        const noul = noulOf(id);
        return noul !== undefined && noul >= YES ? [[item, noul]] : [];
      }).sort((a, b) => b[1] - a[1]);
      const named = likely.map(([item]) => item).slice(0, MAX_FILE_EVIDENCE);
      return push("focused", { result: "fail" }, { ...scored(serves, FOCUSED_PASS_AT, named), ...unread }, named.map(itemText));
    }
    const asked = Object.keys(plan.slices).length;
    // An outage leaves a slice unanswered, and a pull request over the budget is asked nothing.
    if (answered.length < asked || asked + plan.unread.length === 0) {
      anyUnanswered = true;
      return unchecked("focused", unavailable);
    }
    // A file the judge could not get whole may be the separate change, so only a fully read pull request passes.
    if (plan.unread.length > 0) return push("focused", { result: "unconfirmed", reason: UNDECIDED_REASON }, { kind: "could-not-check", reason: UNREAD_REASON, items: plan.unread });
    return push("focused", serves >= FOCUSED_DECIDES ? { result: "pass" } : { result: "unconfirmed", reason: UNDECIDED_REASON }, scored(serves, FOCUSED_PASS_AT, []));
  }

  for (const source of sources.quality) {
    if (source.id === "focused") focusedCheck(focused);
    else fileCheck(source.id, plan[source.id], false);
  }
  for (const row of sources.custom) {
    const { id } = row;
    if (isScoped(row)) {
      fileCheck(id, plan[id], true);
      continue;
    }
    const answer = invalid ? undefined : parsed.decisions[id];
    const noul = answer?.type === "noul" ? answer.noul : undefined;
    const byLevel = row.shape === "score" ? levelsOver(answer, row.levels) : undefined;
    const byOption = row.shape === "choose" ? choiceOver(answer, row.options) : undefined;
    if (row.shape === "is-true" && noul !== undefined) push(id, band(noul, true), scored(noul, PASS_AT, []));
    else if (row.shape === "score" && byLevel) scoreCheck(row, byLevel);
    else if (row.shape === "choose" && byOption) chooseCheck(row, byOption);
    else {
      anyUnanswered = true;
      unchecked(id, unavailable);
    }
  }
  return { checks, unanswered: anyUnanswered };

  /**
   * The likeliest level is the rule's answer. It fails only below `failBelow`, by how likely the level is below it on
   * the unsure band, and without `failBelow` it always passes.
   */
  function scoreCheck(row: Extract<CustomCheck, { shape: "score" }>, byLevel: Record<string, number>) {
    const level = likeliest(byLevel, row.levels);
    const output: CheckOutput = { kind: "level", level, levels: row.levels, ...(row.failBelow && { failBelow: row.failBelow }) };
    const reason = `rated ${level} for ${row.subject}`;
    if (!row.failBelow) return push(row.id, { result: "pass" }, output, [level], reason);
    const below = row.levels.slice(0, row.levels.indexOf(row.failBelow)).reduce((total, name) => total + byLevel[name]!, 0);
    push(row.id, band(1 - below, true), output, [level], reason);
  }

  /** The likeliest option is the rule's answer; it fails by how likely the answer is one of `failOn`, on the unsure band. */
  function chooseCheck(row: Extract<CustomCheck, { shape: "choose" }>, probabilities: Record<string, number>) {
    const chosen = likeliest(probabilities, row.options);
    const failing = row.failOn.reduce((total, option) => total + probabilities[option]!, 0);
    push(row.id, band(1 - failing, true), { kind: "values", values: { chosen } }, [chosen], `best described as ${chosen}`);
  }
}

function withoutLimit(evidence: string[]): string {
  return evidence.map((e) => e.replace(/ \(max .*\)$/, "")).join(", ");
}

function failedStep(c: CheckResult, sources: Sources): Step {
  switch (c.check) {
    // Informational: marking a draft ready is the author's call, never asked of them.
    case NOT_A_DRAFT: return { actor: "maintainer", action: "Review once marked ready" };
    case "ci-green": return { actor: "author", action: c.evidence.length ? `Fix failing CI: ${c.evidence.join(", ")}` : "Fix failing CI" };
    case "no-merge-conflicts": return { actor: "author", action: "Resolve merge conflicts" };
    case "no-forbidden-paths": return { actor: "author", action: `Remove changes under ${c.evidence.join(", ")}` };
    case "max-files-changed":
    case "max-lines-changed": return { actor: "author", action: `Consider splitting it (${withoutLimit(c.evidence)})` };
    case "linked-issue": return { actor: "author", action: "Link an issue" };
    case NO_CHANGES_REQUESTED: {
      const reviewers = c.evidence.map((e) => e.replace(/^changes requested by /, "")).join(", ");
      return c.reason === REVIEW_ANSWERED_REASON
        ? { actor: "maintainer", action: `Re-review: the author responded to changes requested by ${reviewers}` }
        : { actor: "author", action: `Address requested changes from ${reviewers}` };
    }
    case "focused": return { actor: "author", action: c.evidence.length ? `Split out unrelated change: ${c.evidence.join("; ")}` : "Split out unrelated changes" };
    default: return { actor: "author", action: c.kind === "model" && sources ? actionText(c.check, sources) : `Fix ${c.check}` };
  }
}

function unconfirmedSteps(c: CheckResult, sources: Sources): Step[] {
  if (c.check === "no-merge-conflicts") return [{ actor: "system", action: "Wait for GitHub to compute mergeability" }];
  if (c.check === "ci-green") return [{ actor: "system", action: "Wait for checks to finish" }];
  if (c.kind === "model" && sources && c.reason !== NOT_ASKED_REASON) return [{ actor: "maintainer", action: `Confirm ${passText(c.check, sources)}` }];
  return [];
}

const SIZE_RULES: readonly string[] = ["max-files-changed", "max-lines-changed"];

/** Both size limits failing ask for one split, so they read as one step. */
function oneSplit(failed: CheckResult[]): CheckResult[] {
  const sized = failed.filter((c) => SIZE_RULES.includes(c.check));
  if (sized.length < 2) return failed;
  return failed.flatMap((c) => (c === sized[0] ? [{ ...c, evidence: sized.flatMap((s) => s.evidence) }] : sized.includes(c) ? [] : [c]));
}

function nextStep(checks: CheckResult[], sources: Sources, reviewers: string[], verdict: VerdictWord): { actor: Actor; nextAction: string } {
  const failing = oneSplit(checks.filter((c) => c.result === "fail")).map((c) => failedStep(c, sources));
  const steps = failing.length ? failing : checks.filter((c) => c.result === "unconfirmed").flatMap((c) => unconfirmedSteps(c, sources));
  if (!steps.length) {
    const requested = reviewers.length ? ` — ${reviewers.map((r) => `@${r}`).join(", ")} requested` : "";
    return { actor: "maintainer", nextAction: `${verdict === "pass" ? "Review and merge" : "Review"}${requested}` };
  }
  const ordered = ACTOR_ORDER.flatMap((actor) => steps.filter((s) => s.actor === actor));
  const actions = ordered.map((s) => s.action);
  const more = actions.length > MAX_ACTIONS ? ` and ${actions.length - MAX_ACTIONS} more` : "";
  return { actor: ordered[0]!.actor, nextAction: `${actions.slice(0, MAX_ACTIONS).join("; ")}${more}` };
}

/**
 * Pull request text is posted as one-line inline code that cannot mention, link or format: whitespace runs collapse so
 * no line break ends the span, and the fence outruns any backtick run inside (CommonMark).
 */
function inlineCode(text: string): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  const chars = Array.from(flat);
  const line = chars.length > MAX_CODE_CHARS ? `${chars.slice(0, MAX_CODE_CHARS).join("")}…` : flat;
  const fence = "`".repeat(Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return /^`|`$/.test(line) ? `${fence} ${line} ${fence}` : `${fence}${line}${fence}`;
}

/** Cited lines link to the head commit; the link text stays inline code. */
function evidenceCode(c: CheckResult, evidence: string, repo: string, headSha: string): string {
  const citation = citationOf(c.output, evidence);
  const url = citation && citationUrl(repo, headSha, citation);
  return url ? `[${inlineCode(evidence)}](${url})` : inlineCode(evidence);
}

/** A model check the judge was asked about but did not settle; a decision model outage is counted on its own. */
function unsure(c: CheckResult): boolean {
  return c.kind === "model" && c.result === "unconfirmed" && c.reason !== NOT_ASKED_REASON && c.reason !== UNAVAILABLE_REASON;
}

function outageCount(checks: CheckResult[]): number {
  return checks.filter((c) => c.kind === "model" && c.result === "unconfirmed" && c.reason === UNAVAILABLE_REASON).length;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Cut at line boundaries so the comment stays postable, counting the list lines left out. */
function bounded(lines: string[]): string {
  const whole = lines.join("\n");
  if (byteLength(whole) <= MAX_MIRROR_COMMENT_BYTES) return whole;
  for (let kept = lines.length - 1; kept > 0; kept--) {
    const omitted = lines.slice(kept).filter((line) => line.startsWith("- ")).length;
    const cut = [...lines.slice(0, kept), ...(omitted > 0 ? [`- and ${omitted} more`] : [])].join("\n");
    if (byteLength(cut) <= MAX_MIRROR_COMMENT_BYTES) return cut;
  }
  return `- and ${lines.filter((line) => line.startsWith("- ")).length} more`;
}

/** Docs names the files that need docs; other checks, scoped custom ones included, name what they found. */
function failureEvidence(c: CheckResult, repo: string, headSha: string): string {
  if (!c.evidence.length) return "";
  const listed = c.evidence.map((evidence) => evidenceCode(c, evidence, repo, headSha)).join(", ");
  return c.kind === "model" && c.check === "docs" ? ` for ${listed}` : `: ${listed}`;
}

/** The failed checks that are the author's to fix; a maintainer's requested changes are already in front of the author. */
export function authorFailures(all: CheckResult[], sources: Sources): CheckResult[] {
  return all.filter((c) => c.result === "fail" && c.check !== NO_CHANGES_REQUESTED && failedStep(c, sources).actor === "author");
}

const VERDICT_TITLES: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };

export function commentTitle(verdict: VerdictWord): string {
  return `**Triage: ${VERDICT_TITLES[verdict]}**`;
}

/** What a passing comment tells the author when nothing else is listed. */
export const NOTHING_TO_CHANGE = "No changes needed from you. ";

/**
 * Public: the verdict, what the author must fix and what is not yet confirmed; never a score or model reasoning. A
 * maintainer's requested changes are already in front of the author, so they are left out, and a comment holding
 * nothing else is not posted.
 */
function authorComment({ author, repo, headSha, sources }: RenderContext, checks: CheckResult[], verdict: VerdictWord): string {
  const failing = checks.filter((c) => c.result === "fail");
  const mine = authorFailures(checks, sources);
  const unconfirmed = sources ? checks.filter(unsure) : [];
  const lines: string[] = [];
  if (mine.length) {
    lines.push(`@${author}, please address the following:`, ...mine.flatMap((c) => c.check === "focused" && c.evidence.length
      ? c.evidence.map((evidence) => `- Split out unrelated change: ${inlineCode(evidence)}`)
      : [`- ${c.reason}${failureEvidence(c, repo, headSha)}`]));
  }
  if (unconfirmed.length) {
    if (lines.length) lines.push("");
    lines.push("Not yet confirmed, a maintainer will check:", ...unconfirmed.map((c) => `- ${passText(c.check, sources!)}`));
  }
  if (outageCount(checks) > 0) {
    if (lines.length) lines.push("");
    lines.push("Some rules could not run this time. Triage will re-check this pull request.");
  }
  if (!lines.length) {
    if (failing.some((c) => c.check === NO_CHANGES_REQUESTED)) return "";
    lines.push(`${verdict === "pass" ? NOTHING_TO_CHANGE : ""}A maintainer will review this pull request.`);
  }
  return bounded([commentTitle(verdict), "", ...lines]);
}

function reasonOf(c: CheckResult, sources: Sources): string {
  if (c.result === "fail") return c.evidence.length ? `${c.reason}: ${c.evidence.join(", ")}` : c.reason;
  return `Not confirmed: ${c.kind === "model" && sources ? passText(c.check, sources) : c.reason}`;
}

function reasonsOf(det: DeterministicResult, model: CheckResult[]): string[] {
  const hard = det.checks.filter((c) => c.result === "fail" || (c.result === "unconfirmed" && c.check !== NOT_A_DRAFT));
  const soft = model.filter((c) => c.result === "fail" || unsure(c));
  return [...hard.filter((c) => c.result === "fail"), ...hard.filter((c) => c.result !== "fail"), ...soft].map((c) => reasonOf(c, det.sources));
}

type VerdictBase = Omit<RenderOutput, "nextAction" | "actor" | "feedback" | "checks" | "score" | "mirror" | "reasons" | "labels">;

interface RenderContext {
  author: string;
  repo: string;
  headSha: string;
  sources: Sources;
  reviewers: string[];
}

function withChecks(rendered: VerdictBase, checks: CheckResult[], score: number | null, reasons: string[], ctx: RenderContext): RenderOutput {
  return {
    ...rendered,
    ...nextStep(checks, ctx.sources, ctx.reviewers, rendered.verdict),
    mirror: rendered.state !== "stale-unknown",
    labels: [VERDICT_LABELS[rendered.verdict]],
    score,
    reasons,
    feedback: authorComment(ctx, checks, rendered.verdict),
    checks,
  };
}

const VERDICT_STATES: Record<VerdictWord, WorkflowState> = { pass: "ready-monitoring", fail: "needs-author-update", unsure: "awaiting-review" };

/** Pass or fail only when that choice clears the bar; anything else is unsure. */
function decide(choice: Record<VerdictChoice, number>): VerdictWord {
  if (choice.pass >= VERDICT_DECIDES) return "pass";
  if (choice.fail >= VERDICT_DECIDES) return "fail";
  return "unsure";
}

const DECIDED_REASONS: Record<VerdictWord, string> = {
  pass: "passes the repository's policy",
  fail: "does not pass the repository's policy",
  unsure: "the decision model could not tell whether it passes the repository's policy",
};

export const RULES_PASS_REASON = "every rule passed, and the policy has no decision-model rule";
const RULES_UNSURE_REASON = "not every rule could be confirmed, and the policy has no decision-model rule";
const UNCONFIRMED_REASON = "the decision model passed it, but a rule could not be confirmed";

/**
 * A failed hard rule decides Fail without the decision model; a draft or closed pull request is not decided, and is
 * unsure. A policy without a decision-model rule passes when every rule passes, and is unsure while any is unconfirmed.
 * Otherwise the verdict question decides, and a judge that did not answer leaves the verdict unsure and degraded.
 */
export function renderVerdict(input: RenderInput): RenderOutput {
  const { author, repo, headSha, det, judgeError, judgeLimitExceeded, judgeSkipped, reviewers = [], choice, choiceRefused } = input;
  const ctx = { author, repo, headSha, sources: det.sources, reviewers };
  const evaluated = evaluateModel(input);
  const checks = [...det.checks, ...evaluated.checks];
  const reasons = reasonsOf(det, evaluated.checks);
  const hard = hardFailures(det.checks);
  if (hard.length > 0) return withChecks({ ...render(det.state), verdict: "fail", degraded: null, reason: det.reason }, checks, null, reasons, ctx);
  if (!det.needsJudgment) {
    const verdict = withChecks({ ...render(det.state), verdict: "unsure", degraded: null, reason: det.reason }, checks, null, reasons, ctx);
    return { ...verdict, feedback: "" };
  }
  if (!hasModelChecks(det.sources)) {
    if (det.checks.every((c) => c.result === "pass")) return withChecks({ ...render("ready-monitoring"), verdict: "pass", degraded: null, reason: RULES_PASS_REASON }, checks, null, reasons, ctx);
    return unsureOf(RULES_UNSURE_REASON);
  }
  function unsureOf(reason: string, degraded: RenderOutput["degraded"] = null): RenderOutput {
    return withChecks({ ...render("awaiting-review"), verdict: "unsure", degraded, reason }, checks, null, reasons, ctx);
  }
  if (judgeSkipped === true) return unsureOf(NEEDS_JUDGE_REASON);
  if (judgeLimitExceeded === true) return unsureOf(judgeError!);
  if (choiceRefused !== undefined) return unsureOf(choiceRefused);
  const outage = `${UNAVAILABLE_REASON}: ${judgeError ?? "no answer"}`;
  if (judgeError !== undefined || evaluated.unanswered) return unsureOf(outage, "inference-outage");
  // A judged rule's own answer decides it, so nothing the pull request says to the verdict question can pass it.
  const failing = evaluated.checks.filter((check) => check.result === "fail").map((check) => reasonOf(check, det.sources));
  if (failing.length) return withChecks({ ...render(VERDICT_STATES.fail), verdict: "fail", degraded: null, reason: failing.join("; ") }, checks, null, reasons, ctx);
  if (choice === undefined) return unsureOf(outage, "inference-outage");
  const decided = decide(choice);
  if (decided === "pass" && checks.some((check) => check.result === "unconfirmed")) return unsureOf(UNCONFIRMED_REASON);
  return withChecks({ ...render(VERDICT_STATES[decided]), verdict: decided, degraded: null, reason: DECIDED_REASONS[decided] }, checks, choice.pass, reasons, ctx);
}

export function degradedVerdict(reason: string): RenderOutput {
  return {
    ...render("stale-unknown"),
    mirror: false,
    labels: [VERDICT_LABELS.unsure],
    verdict: "unsure",
    score: null,
    reasons: ["Could not evaluate"],
    degraded: "error",
    checks: [],
    reason,
    nextAction: "Retry when data is available",
    actor: "system",
    feedback: "",
  };
}

export interface MirrorRequest {
  repo: string;
  number: number;
  labels: string[];
  owned: readonly string[];
  comment: string;
  /** What the comment is written for; absent on a verdict that names no head. */
  header?: TriageHeader;
}

export type Verdict = RenderOutput & {
  repo: string;
  number: number;
  headSha: string | null;
  /** Where the pull request lives; absent on GitHub. */
  repoSource?: RepoSource;
  request: MirrorRequest;
  automatic: ActionKind[];
  actions: SuggestedAction[];
  judged?: Judged;
  /** Set when the pack has an approve Do: whether this head may be approved. */
  approvable?: boolean;
  /** Set when the pack has a request-changes Do: whether anything failed is the author's to fix on this head. */
  changesWanted?: boolean;
};

/** `owned` is the labels the mirror takes back: triage's own, and the policy's verdict labels when there is a policy. */
export function toMirrorRequest(v: RenderOutput & { repo: string; number: number; headSha: string | null }, owned: readonly string[] = TRIAGE_LABELS, policy?: PolicySource): MirrorRequest {
  return {
    repo: v.repo,
    number: v.number,
    labels: v.labels,
    owned,
    comment: v.feedback,
    ...(v.headSha !== null && { header: { head: v.headSha, policy: policy ?? null, verdict: v.verdict } }),
  };
}

export interface BacklogSummary {
  total: number;
  classified: number;
  coverage: string;
  byState: Record<string, number>;
}

export function summarize(results: Array<RenderOutput | null>): BacklogSummary {
  const done = results.filter((r): r is RenderOutput => r !== null);
  const byState: Record<string, number> = {};
  for (const r of done) byState[r.state] = (byState[r.state] ?? 0) + 1;
  return { total: results.length, classified: done.length, coverage: `${done.length}/${results.length}`, byState };
}
