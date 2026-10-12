import { render, TRIAGE_LABELS, type Rendered, type TriageState } from "@corbits/rule-packs";
import { citationOf, citationUrl, itemText, type CheckItem, type CheckOutput, type CleanupMode, type RuleCustomCheck } from "@corbits/triage-contracts";
import type { SuggestedAction } from "./actions.js";
import { REVIEW_ANSWERED_REASON, type CheckResult, type DeterministicResult } from "./checks.js";
import type { ChangeCandidate } from "./candidates.js";
import type { Judged } from "./item.js";
import { asText } from "./extract.js";
import { actionText, askedQuestionIds, failureText, FOCUSED_CHOICES, focusedCandidateId, isScoped, passText, type FilePlan, type FocusedChoice, type QualityPlan } from "./quality.js";

type NoulAnswer = { type: "noul"; noul: number };
type ChoiceAnswer = { type: "choice"; choice: FocusedChoice; probabilities: Record<FocusedChoice, number>; confidence: number };
type ModelAnswer = NoulAnswer | ChoiceAnswer;

export interface ParsedAnswers {
  decisions: Record<string, ModelAnswer>;
  malformed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseDecision(value: Record<string, unknown>): { id: string; answer: ModelAnswer } | null {
  if (value.type === "noul") {
    if (!exactKeys(value, ["id", "type", "noul"]) || typeof value.id !== "string" || !probability(value.noul)) return null;
    return { id: value.id, answer: { type: "noul", noul: value.noul } };
  }
  if (value.type !== "choice" || !exactKeys(value, ["id", "type", "choice", "probabilities", "confidence"]) ||
    typeof value.id !== "string" || !FOCUSED_CHOICES.includes(value.choice as FocusedChoice) || !probability(value.confidence) ||
    !isRecord(value.probabilities) || !exactKeys(value.probabilities, [...FOCUSED_CHOICES])) return null;
  const probabilities = value.probabilities as Record<FocusedChoice, unknown>;
  if (!FOCUSED_CHOICES.every((choice) => probability(probabilities[choice]))) return null;
  const sum = FOCUSED_CHOICES.reduce((total, choice) => total + (probabilities[choice] as number), 0);
  if (Math.abs(sum - 1) > 0.02) return null;
  return {
    id: value.id,
    answer: {
      type: "choice",
      choice: value.choice as FocusedChoice,
      probabilities: probabilities as Record<FocusedChoice, number>,
      confidence: value.confidence,
    },
  };
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
  /** The pull request's repository and head commit, which the comment links cited lines into. */
  repo: string;
  headSha: string;
  det: DeterministicResult;
  answers?: ParsedAnswers | Record<string, number> | null;
  candidates?: ChangeCandidate[];
  /** How docs and tests are decided, from the same evaluation as `candidates`. */
  plan?: QualityPlan;
  judgeError?: string;
  judgeLimitExceeded?: true;
  judgeSkipped?: true;
  /** Logins of requested reviewers. */
  reviewers?: string[];
  /** The pack's merge threshold. */
  threshold: number;
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

/** Whether this pull request should merge now; shown in the portal, never posted to GitHub. */
export interface MergeVerdict {
  verdict: "ready" | "not-recommended";
  score: number | null;
  threshold: number;
  reasons: string[];
}

export interface RenderOutput extends Rendered {
  mirror: boolean;
  duplicate: boolean;
  /** Only a human-confirmed duplicate closes a PR; no automated path sets this. */
  close: boolean;
  /** The weakest model answer's confidence; null when no model check was asked. */
  score: number | null;
  /** @deprecated Read `score`; kept for one release because old run logs carry it. */
  confidence: number | "unknown";
  merge: MergeVerdict;
  degraded: "inference-outage" | "error" | null;
  checks: CheckResult[];
  /** The reason the verdict was rendered with. */
  reason: string;
  nextAction: string;
  actor: Actor;
  /** The comment to post for the author; empty only when nothing is posted. */
  feedback: string;
}

type Sources = DeterministicResult["sources"];

interface Step {
  actor: Actor;
  action: string;
}

// Only these states let model answers drive the verdict; anything worse is driven by its machine findings.
const JUDGED_STATES = new Set<TriageState>(["ready-monitoring", "awaiting-review"]);
const ACTOR_ORDER: Actor[] = ["author", "maintainer", "system"];
const MAX_ACTIONS = 2;
// Jev's yes/no answers are calibrated probabilities: decide only well clear of a coin flip, otherwise leave it unsure.
const YES = 0.7;
const NO = 0.3;
// A focused candidate counts as unrelated, or as part of the change, only when that side holds this much probability.
const FOCUSED_DECIDES = 0.6;
const MAX_FILE_EVIDENCE = 3;
/** An answer clear of the unsure band: the verdict it drives would not change were it asked again. */
function isDecisive(answer: ModelAnswer): boolean {
  if (answer.type === "noul") return answer.noul >= YES || answer.noul <= NO;
  const { probabilities } = answer;
  return probabilities.unrelated >= FOCUSED_DECIDES || probabilities.primary_or_supporting + probabilities.movement_or_superseded >= FOCUSED_DECIDES;
}

/** A judge reply a later run may reuse: well formed, with every answer decisive. */
export function isReusableReply(reply: string): boolean {
  const { decisions, malformed } = parseAnswers(reply);
  return !malformed && Object.values(decisions).every(isDecisive);
}

// The score, out of 100, at which a model check's answer passes: the band's yes edge, or focused's deciding share.
const PASS_AT = Math.round(YES * 100);
const FOCUSED_PASS_AT = Math.round(FOCUSED_DECIDES * 100);

type ModelEvaluation = {
  checks: CheckResult[];
  scores: number[];
  /** Some asked question got no usable answer. */
  unanswered: boolean;
};

function answerSet(answers: RenderInput["answers"]): ParsedAnswers {
  if (answers && "decisions" in answers && "malformed" in answers) return answers as ParsedAnswers;
  const decisions: Record<string, ModelAnswer> = {};
  for (const [id, value] of Object.entries(answers ?? {})) {
    if (!probability(value)) return { decisions: {}, malformed: true };
    decisions[id] = { type: "noul", noul: value };
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

function evaluateModel({ det, answers, candidates = [], plan = {}, judgeError, judgeLimitExceeded, judgeSkipped }: RenderInput): ModelEvaluation {
  if (!det.sources) return { checks: [], scores: [], unanswered: false };
  const sources = det.sources;
  // A failed chunk leaves only its own questions unanswered; the other chunks' answers still count.
  const parsed = answerSet(det.needsJudgment ? answers : null);
  const expectedIds = askedQuestionIds(sources, candidates, plan);
  const unavailable = !det.needsJudgment ? NOT_ASKED_REASON : judgeSkipped ? NEEDS_JUDGE_REASON : judgeLimitExceeded ? judgeError! : UNAVAILABLE_REASON;
  const invalid = parsed.malformed || Object.keys(parsed.decisions).some((id) => !expectedIds.has(id));
  const checks: CheckResult[] = [];
  const scores: number[] = [];
  let anyUnanswered = false;

  function noulOf(id: string): number | undefined {
    const answer = invalid ? undefined : parsed.decisions[id];
    return answer?.type === "noul" ? answer.noul : undefined;
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
   * Docs and tests pass on a changed doc or test file and their questions are answered yes when a file needs one; a
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
      scores.push(needing[0]![1]);
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
    if (decided.result === "pass") scores.push(1 - weakest[1]);
    return push(check, decided, scored(1 - weakest[1], PASS_AT, [weakest[0]]));
  }

  for (const source of sources.quality) {
    if (source.id !== "focused") {
      fileCheck(source.id, plan[source.id], false);
      continue;
    }
    const unrelated: string[] = [];
    const unread = new Set<string>();
    // How much probability says the candidate belongs to the change, least first among all and among the unrelated.
    let weakest: [string, number] | undefined;
    let weakestUnrelated: number | undefined;
    let candidateUnresolved = candidates.length === 0;
    let unanswered = judgeLimitExceeded === true;
    for (const [index, candidate] of candidates.entries()) {
      const item = `${candidate.label} — ${candidate.path}`;
      if (!candidate.evidence) {
        candidateUnresolved = true;
        unread.add(candidate.path);
        continue;
      }
      const answer = invalid ? undefined : parsed.decisions[focusedCandidateId(index)];
      if (answer?.type !== "choice") {
        candidateUnresolved = true;
        unanswered = true;
        continue;
      }
      const { probabilities } = answer;
      const related = probabilities.primary_or_supporting + probabilities.movement_or_superseded;
      if (weakest === undefined || related < weakest[1]) weakest = [item, related];
      if (probabilities.unrelated >= FOCUSED_DECIDES || related >= FOCUSED_DECIDES) scores.push(Math.max(probabilities.unrelated, related));
      if (probabilities.unrelated >= FOCUSED_DECIDES) {
        if (!unrelated.includes(item)) unrelated.push(item);
        weakestUnrelated = Math.min(weakestUnrelated ?? related, related);
      } else if (related < FOCUSED_DECIDES) {
        candidateUnresolved = true;
      }
    }
    anyUnanswered ||= unanswered;
    const reason = !det.needsJudgment ? NOT_ASKED_REASON : candidates.length === 0 ? "no change candidates" : unanswered ? unavailable : UNDECIDED_REASON;
    const unreadPaths = [...unread];
    // A failure scores the unrelated candidates it names; otherwise every candidate must have been read and answered for a score.
    const output: CheckOutput = weakestUnrelated !== undefined ? { ...scored(weakestUnrelated, FOCUSED_PASS_AT, unrelated), ...(unreadPaths.length > 0 ? { unread: unreadPaths } : {}) }
      : weakest !== undefined && !unanswered && unreadPaths.length === 0 ? scored(weakest[1], FOCUSED_PASS_AT, [weakest[0]])
        : det.needsJudgment && !unanswered && unreadPaths.length > 0 ? { kind: "could-not-check", reason: UNREAD_REASON, items: unreadPaths }
          : { kind: "could-not-check", reason };
    push("focused", unrelated.length > 0 ? { result: "fail" } : candidateUnresolved ? { result: "unconfirmed", reason } : { result: "pass" }, output, unrelated);
  }
  for (const row of sources.custom) {
    const { id } = row;
    if (isScoped(row)) {
      fileCheck(id, plan[id], true);
      continue;
    }
    const noul = noulOf(id);
    if (noul === undefined) {
      anyUnanswered = true;
      unchecked(id, unavailable);
      continue;
    }
    const decided = band(noul, true);
    if (decided.result !== "unconfirmed") scores.push(Math.max(noul, 1 - noul));
    push(id, decided, scored(noul, PASS_AT, []));
  }
  return { checks, scores, unanswered: anyUnanswered };
}

function withoutLimit(evidence: string[]): string {
  return evidence.map((e) => e.replace(/ \(max .*\)$/, "")).join(", ");
}

function failedStep(c: CheckResult, sources: Sources): Step {
  switch (c.check) {
    // Informational: marking a draft ready is the author's call, never asked of them.
    case "draft": return { actor: "maintainer", action: "Review once marked ready" };
    case "ci": return { actor: "author", action: c.evidence.length ? `Fix failing CI: ${c.evidence.join(", ")}` : "Fix failing CI" };
    case "conflicts": return { actor: "author", action: "Resolve merge conflicts" };
    case "paths": return { actor: "author", action: `Remove changes under ${c.evidence.join(", ")}` };
    case "size": return { actor: "author", action: `Consider splitting it (${withoutLimit(c.evidence)})` };
    case "issue": return { actor: "author", action: "Link an issue" };
    case "review": {
      const reviewers = c.evidence.map((e) => e.replace(/^changes requested by /, "")).join(", ");
      return c.reason === REVIEW_ANSWERED_REASON
        ? { actor: "maintainer", action: `Re-review: the author responded to changes requested by ${reviewers}` }
        : { actor: "author", action: `Address requested changes from ${reviewers}` };
    }
    case "duplicate": return { actor: "maintainer", action: `Confirm duplicate of ${c.evidence.join(", ")} or keep` };
    case "reviewers": return { actor: "maintainer", action: "Assign a reviewer" };
    case "drift": return { actor: "maintainer", action: `Decide on base drift (${withoutLimit(c.evidence)})` };
    case "focused": return { actor: "author", action: `Split out unrelated change: ${c.evidence.join("; ")}` };
    default: {
      const rule = sources?.rules.find((r) => r.id === c.check);
      if (rule) return ruleStep(rule, c);
      return { actor: "author", action: c.kind === "model" && sources ? actionText(c.check, sources) : `Fix ${c.check}` };
    }
  }
}

/** Labels and approvals are the maintainer's; everything else names what the author changes. */
function ruleStep(rule: RuleCustomCheck, c: CheckResult): Step {
  const where = c.evidence.map(inlineCode).join(", ");
  switch (rule.rule) {
    case "paths-unchanged": return { actor: "author", action: `Revert changes under ${where}` };
    case "paths-together": return { actor: "author", action: `Also change ${rule.requires.map(inlineCode).join(", ")}` };
    case "title-pattern": return { actor: "author", action: `Retitle to match ${inlineCode(rule.pattern)}` };
    case "branch-pattern": return { actor: "author", action: `Rename the branch to match ${inlineCode(rule.pattern)}` };
    case "diff-excludes": return { actor: "author", action: `Remove the excluded content at ${where}` };
    case "label-required": return { actor: "maintainer", action: `Add label ${inlineCode(rule.label)}` };
    case "min-approvals": return { actor: "maintainer", action: `Approve (${where})` };
    case "author": throw new Error("an author gate never produces a step");
  }
}

/** Gates decide action branches; they are never something to fix. */
function judged(checks: CheckResult[]): CheckResult[] {
  return checks.filter((c) => !c.gate);
}

function unconfirmedSteps(c: CheckResult, sources: Sources): Step[] {
  if (c.check === "conflicts") return [{ actor: "system", action: "Wait for GitHub to compute mergeability" }];
  if (c.kind === "model" && sources && c.reason !== NOT_ASKED_REASON) return [{ actor: "maintainer", action: `Confirm ${passText(c.check, sources)}` }];
  return [];
}

function nextStep(all: CheckResult[], sources: Sources, reviewers: string[]): { actor: Actor; nextAction: string } {
  const checks = judged(all);
  const failing = checks.filter((c) => c.result === "fail").map((c) => failedStep(c, sources));
  const steps = failing.length ? failing : checks.filter((c) => c.result === "unconfirmed").flatMap((c) => unconfirmedSteps(c, sources));
  if (!steps.length) {
    const requested = reviewers.length ? ` — ${reviewers.map((r) => `@${r}`).join(", ")} requested` : "";
    return { actor: "maintainer", nextAction: `Review and merge${requested}` };
  }
  const ordered = ACTOR_ORDER.flatMap((actor) => steps.filter((s) => s.actor === actor));
  const actions = ordered.map((s) => s.action);
  const more = actions.length > MAX_ACTIONS ? ` and ${actions.length - MAX_ACTIONS} more` : "";
  return { actor: ordered[0]!.actor, nextAction: `${actions.slice(0, MAX_ACTIONS).join("; ")}${more}` };
}

/** Labels and paths come from the pull request, so they are posted as inline code that cannot mention, link or format. */
function inlineCode(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
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

/** Docs and tests name the files that need them; other checks, scoped custom ones included, name what they found. */
function failureEvidence(c: CheckResult, repo: string, headSha: string): string {
  if (!c.evidence.length) return "";
  const listed = c.evidence.map((evidence) => evidenceCode(c, evidence, repo, headSha)).join(", ");
  return c.kind === "model" && (c.check === "docs" || c.check === "tests") ? ` for ${listed}` : `: ${listed}`;
}

/**
 * Public: only what the author must fix and what is not yet confirmed; never a score or model reasoning. A maintainer's
 * requested changes are already in front of the author, so they are left out, and a comment holding nothing else is not posted.
 */
function authorComment({ author, repo, headSha, sources }: RenderContext, all: CheckResult[]): string {
  const checks = judged(all);
  const failing = checks.filter((c) => c.result === "fail");
  const mine = failing.filter((c) => c.check !== "review" && failedStep(c, sources).actor === "author");
  const unconfirmed = sources ? checks.filter(unsure) : [];
  const lines: string[] = [];
  if (mine.length) {
    lines.push(`@${author}, please address the following:`, ...mine.flatMap((c) => c.check === "focused"
      ? c.evidence.map((evidence) => `- Split out unrelated change: ${inlineCode(evidence)}`)
      : [`- ${c.reason}${failureEvidence(c, repo, headSha)}`]));
  }
  if (unconfirmed.length) {
    if (lines.length) lines.push("");
    lines.push("Not yet confirmed, a maintainer will check:", ...unconfirmed.map((c) => `- ${passText(c.check, sources!)}`));
  }
  if (outageCount(checks) > 0) {
    if (lines.length) lines.push("");
    lines.push("Some checks could not run this time. Triage will re-check this pull request.");
  }
  if (!lines.length) {
    if (failing.some((c) => c.check === "review")) return "";
    lines.push("No changes needed from you. A maintainer will review this pull request.");
  }
  return bounded(lines);
}

function scoreOf(scores: number[]): number | null {
  return scores.length > 0 ? Math.round(Math.min(...scores) * 100) / 100 : null;
}

/** Red when anything fails or is unconfirmed, or the score is under the threshold; a null score skips the threshold. */
function mergeVerdict(all: CheckResult[], sources: Sources, score: number | null, threshold: number): MergeVerdict {
  const checks = judged(all);
  const outage = outageCount(checks);
  const reasons = [
    ...(outage > 0 ? [`Could not evaluate ${outage} ${outage === 1 ? "check" : "checks"}`] : []),
    ...checks.flatMap((c) => {
      if (c.result === "fail") return [`Failed: ${c.reason}`];
      if (c.result !== "unconfirmed" || c.reason === NOT_ASKED_REASON || c.reason === UNAVAILABLE_REASON) return [];
      return [`Not confirmed: ${c.kind === "model" && sources ? passText(c.check, sources) : c.reason}`];
    }),
    ...(score !== null && score < threshold ? [`Score ${score} is below the threshold ${threshold}`] : []),
  ];
  return { verdict: reasons.length ? "not-recommended" : "ready", score, threshold, reasons };
}

type VerdictBase = Omit<RenderOutput, "nextAction" | "actor" | "feedback" | "checks" | "merge" | "score" | "confidence" | "mirror">;

interface RenderContext {
  author: string;
  repo: string;
  headSha: string;
  sources: Sources;
  reviewers: string[];
  threshold: number;
}

function withChecks(rendered: VerdictBase, checks: CheckResult[], score: number | null, ctx: RenderContext, commented = checks): RenderOutput {
  const { sources, reviewers, threshold } = ctx;
  return {
    ...rendered,
    ...nextStep(checks, sources, reviewers),
    mirror: rendered.state !== "stale-unknown",
    score,
    confidence: score ?? "unknown",
    merge: mergeVerdict(checks, sources, score, threshold),
    feedback: authorComment(ctx, commented),
    checks,
  };
}

export function renderVerdict(input: RenderInput): RenderOutput {
  const { author, repo, headSha, det, judgeError, judgeLimitExceeded, judgeSkipped, reviewers = [], threshold } = input;
  const ctx = { author, repo, headSha, sources: det.sources, reviewers, threshold };
  const evaluated = evaluateModel(input);
  const checks = [...det.checks, ...evaluated.checks];
  const score = scoreOf(evaluated.scores);
  if (!det.needsJudgment || !det.sources || !JUDGED_STATES.has(det.state)) {
    const duplicate = det.duplicateOf !== null && det.state === "needs-decision";
    const verdict = withChecks({ ...render(det.state), duplicate, close: false, degraded: null, reason: det.reason }, checks, score, ctx, det.checks);
    // Model answers do not drive this verdict, so the comment speaks only to the machine checks; a closed pull request gets none.
    return det.findings.some((f) => f.check === "state") ? { ...verdict, feedback: "" } : verdict;
  }
  const failing = evaluated.checks.filter((check) => check.result === "fail");
  const unconfirmed = evaluated.checks.some((check) => check.result === "unconfirmed" && check.reason !== NOT_ASKED_REASON);
  const state = failing.length ? "needs-author-update" : unconfirmed ? "awaiting-review" : det.state;
  const outage = judgeLimitExceeded !== true && judgeSkipped !== true && (judgeError !== undefined || evaluated.unanswered);
  const focused = failing.find((check) => check.check === "focused");
  const reasons = failing.map((check) => check === focused && check.evidence.length
    ? `${check.reason}: ${check.evidence.join(", ")}`
    : check.reason);
  const reason = judgeLimitExceeded === true ? judgeError!
    : judgeSkipped === true ? NEEDS_JUDGE_REASON
      : outage ? `${UNAVAILABLE_REASON}: ${judgeError ?? "no answer"}`
        : reasons.length ? reasons.join("; ") : det.reason;
  return withChecks({ ...render(state), duplicate: false, close: false, degraded: outage ? "inference-outage" : null, reason }, checks, score, ctx);
}

export function degradedVerdict(reason: string, threshold: number): RenderOutput {
  return {
    ...render("stale-unknown"),
    mirror: false,
    duplicate: false,
    close: false,
    score: null,
    confidence: "unknown",
    merge: { verdict: "not-recommended", score: null, threshold, reasons: ["Could not evaluate"] },
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
  close: boolean;
}

export type Verdict = RenderOutput & {
  repo: string;
  number: number;
  headSha: string | null;
  request: MirrorRequest;
  cleanupMode?: CleanupMode;
  actions: SuggestedAction[];
  /** The judge answers a later run of this head reuses instead of asking again. */
  judged?: Judged;
};

export function toMirrorRequest(v: RenderOutput & { repo: string; number: number }): MirrorRequest {
  return {
    repo: v.repo,
    number: v.number,
    labels: v.labels,
    owned: TRIAGE_LABELS,
    comment: v.feedback,
    close: v.close,
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
