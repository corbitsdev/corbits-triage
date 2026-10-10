import { render, TRIAGE_LABELS, type Rendered, type TriageState } from "@corbits/rule-packs";
import type { CleanupMode } from "@corbits/triage-contracts";
import type { SuggestedAction } from "./actions.js";
import type { CheckResult, DeterministicResult } from "./checks.js";
import type { ChangeCandidate } from "./candidates.js";
import { asText } from "./extract.js";
import { actionText, failureText, FOCUSED_CHOICES, focusedCandidateId, passText, qualityQuestions, type FocusedChoice } from "./quality.js";

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
  det: DeterministicResult;
  answers?: ParsedAnswers | Record<string, number> | null;
  candidates?: ChangeCandidate[];
  judgeError?: string;
  judgeLimitExceeded?: true;
  judgeSkipped?: true;
  /** Logins of requested reviewers. */
  reviewers?: string[];
}

export type Actor = "author" | "maintainer" | "system";

export const MAX_MIRROR_COMMENT_BYTES = 60_000;

export const NEEDS_JUDGE_REASON = "needs the judge";

export interface RenderOutput extends Rendered {
  mirror: boolean;
  duplicate: boolean;
  /** Only a human-confirmed duplicate closes a PR; no automated path sets this. */
  close: boolean;
  confidence: number | "unknown";
  degraded: "inference-outage" | "error" | null;
  checks: CheckResult[];
  /** The reason the verdict was rendered with. */
  reason: string;
  nextAction: string;
  actor: Actor;
  /** The comment to post for the author; empty when nothing is required of them. */
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

type ModelEvaluation = {
  checks: CheckResult[];
  scores: number[];
  focusedUnresolved: boolean;
  noulUnresolved: boolean;
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

function evaluateModel({ det, answers, candidates = [], judgeError, judgeSkipped }: RenderInput): ModelEvaluation {
  if (!det.sources) return { checks: [], scores: [], focusedUnresolved: false, noulUnresolved: false };
  const parsed = answerSet(det.needsJudgment && judgeError === undefined ? answers : null);
  const expectedIds = new Set(qualityQuestions(det.sources, candidates).map((question) => question.id));
  const unavailable = !det.needsJudgment ? "not asked" : judgeSkipped ? NEEDS_JUDGE_REASON : "decision model unavailable";
  const invalid = parsed.malformed || judgeError !== undefined || Object.keys(parsed.decisions).some((id) => !expectedIds.has(id));
  const checks: CheckResult[] = [];
  const scores: number[] = [];
  let focusedUnresolved = false;
  let noulUnresolved = false;

  for (const source of det.sources.quality) {
    if (source.id === "focused") {
      const unrelated: string[] = [];
      let candidateUnresolved = candidates.length === 0;
      for (const [index, candidate] of candidates.entries()) {
        const answer = invalid ? undefined : parsed.decisions[focusedCandidateId(index)];
        if (answer?.type !== "choice") {
          candidateUnresolved = true;
          continue;
        }
        scores.push(answer.confidence);
        if (!candidate.evidence || answer.confidence < 0.5 || answer.choice === "ambiguous") {
          candidateUnresolved = true;
        } else if (answer.choice === "unrelated") {
          const evidence = `${candidate.label} — ${candidate.path}`;
          if (!unrelated.includes(evidence)) unrelated.push(evidence);
        }
      }
      focusedUnresolved ||= candidateUnresolved;
      checks.push(unrelated.length > 0
        ? { check: "focused", kind: "model", result: "fail", reason: failureText("focused", det.sources), evidence: unrelated }
        : candidateUnresolved
          ? { check: "focused", kind: "model", result: "unconfirmed", reason: !det.needsJudgment ? "not asked" : candidates.length === 0 ? "no change candidates" : unavailable, evidence: [] }
          : { check: "focused", kind: "model", result: "pass", reason: passText("focused", det.sources), evidence: [] });
      continue;
    }
    const answer = invalid ? undefined : parsed.decisions[source.id];
    if (answer?.type !== "noul") {
      noulUnresolved = true;
      checks.push({ check: source.id, kind: "model", result: "unconfirmed", reason: unavailable, evidence: [] });
      continue;
    }
    scores.push(Math.max(answer.noul, 1 - answer.noul));
    const failed = answer.noul < 0.5;
    checks.push({ check: source.id, kind: "model", result: failed ? "fail" : "pass", reason: failed ? failureText(source.id, det.sources) : passText(source.id, det.sources), evidence: [] });
  }
  for (const { id } of det.sources.custom) {
    const answer = invalid ? undefined : parsed.decisions[id];
    if (answer?.type !== "noul") {
      noulUnresolved = true;
      checks.push({ check: id, kind: "model", result: "unconfirmed", reason: unavailable, evidence: [] });
      continue;
    }
    scores.push(Math.max(answer.noul, 1 - answer.noul));
    const failed = answer.noul < 0.5;
    checks.push({ check: id, kind: "model", result: failed ? "fail" : "pass", reason: failed ? failureText(id, det.sources) : passText(id, det.sources), evidence: [] });
  }
  return { checks, scores, focusedUnresolved, noulUnresolved };
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
    case "size": return { actor: "author", action: `Split into smaller pull requests (${withoutLimit(c.evidence)})` };
    case "issue": return { actor: "author", action: "Link an issue" };
    case "review": return { actor: "author", action: `Address requested changes from ${c.evidence.map((e) => e.replace(/^changes requested by /, "")).join(", ")}` };
    case "duplicate": return { actor: "maintainer", action: `Confirm duplicate of ${c.evidence.join(", ")} or keep` };
    case "reviewers": return { actor: "maintainer", action: "Assign a reviewer" };
    case "drift": return { actor: "maintainer", action: `Decide on base drift (${withoutLimit(c.evidence)})` };
    case "focused": return { actor: "author", action: `Split out unrelated change: ${c.evidence.join("; ")}` };
    default: return { actor: "author", action: c.kind === "model" && sources ? actionText(c.check, sources) : `Fix ${c.check}` };
  }
}

function unconfirmedSteps(c: CheckResult, sources: Sources): Step[] {
  if (c.check === "conflicts") return [{ actor: "system", action: "Wait for GitHub to compute mergeability" }];
  if (c.kind === "model" && sources && c.reason !== "not asked") return [{ actor: "maintainer", action: `Confirm ${passText(c.check, sources)}` }];
  return [];
}

function nextStep(checks: CheckResult[], sources: Sources, reviewers: string[]): { actor: Actor; nextAction: string } {
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

/** Only checks the author can fix are posted; everything else is for maintainers in the portal. */
function authorComment(author: string, checks: CheckResult[], sources: Sources): string {
  const mine = checks.filter((c) => c.result === "fail" && failedStep(c, sources).actor === "author");
  if (!mine.length) return "";
  const lines = mine.flatMap((c) => c.check === "focused"
    ? c.evidence.map((evidence) => `- Split out unrelated change: ${inlineCode(evidence)}`)
    : [`- ${c.reason}${c.evidence.length ? `: ${c.evidence.join(", ")}` : ""}`]);
  return [`@${author}, please address the following:`, ...lines].join("\n");
}

function withChecks<T extends Rendered>(rendered: T, checks: CheckResult[], { author, sources, reviewers }: { author: string; sources: Sources; reviewers: string[] }) {
  return { ...rendered, ...nextStep(checks, sources, reviewers), feedback: authorComment(author, checks, sources), checks };
}

function enforceMirrorCommentBound(verdict: RenderOutput): RenderOutput {
  if (new TextEncoder().encode(verdict.feedback).byteLength <= MAX_MIRROR_COMMENT_BYTES) return verdict;
  return {
    ...verdict,
    mirror: false,
    humanGated: true,
  };
}

export function renderVerdict(input: RenderInput): RenderOutput {
  const { author, det, judgeError, judgeLimitExceeded, judgeSkipped, reviewers = [] } = input;
  const ctx = { author, sources: det.sources, reviewers };
  const evaluated = evaluateModel(input);
  const checks = [...det.checks, ...evaluated.checks];
  if (!det.needsJudgment || !det.sources || !JUDGED_STATES.has(det.state)) {
    const duplicate = det.duplicateOf !== null && det.state === "needs-decision";
    const verdict = withChecks({ ...render(det.state), mirror: det.state !== "stale-unknown", duplicate, close: false, confidence: "unknown" as const, degraded: null, reason: det.reason }, det.checks, ctx);
    return enforceMirrorCommentBound({ ...verdict, checks });
  }
  if (judgeLimitExceeded === true) {
    const reason = `decision model unavailable: ${judgeError}`;
    return enforceMirrorCommentBound(withChecks({ ...render(det.state, { humanGated: true }), mirror: false, duplicate: false, close: false, confidence: "unknown" as const, degraded: null, reason }, checks, ctx));
  }
  if (judgeSkipped === true) {
    return enforceMirrorCommentBound(withChecks({ ...render(det.state, { humanGated: true }), mirror: false, duplicate: false, close: false, confidence: "unknown" as const, degraded: null, reason: NEEDS_JUDGE_REASON }, checks, ctx));
  }
  if (judgeError !== undefined || evaluated.noulUnresolved) {
    const reason = `decision model unavailable: ${judgeError ?? "no answer"}`;
    return enforceMirrorCommentBound(withChecks({ ...render(det.state, { humanGated: true }), mirror: false, duplicate: false, close: false, confidence: "unknown" as const, degraded: "inference-outage" as const, reason }, checks, ctx));
  }
  const confidence = evaluated.scores.length > 0
    ? Math.round(Math.min(...evaluated.scores) * 100) / 100
    : "unknown" as const;
  const failing = evaluated.checks.filter((check) => check.result === "fail");
  const focused = failing.find((check) => check.check === "focused");
  const reasons = failing.map((check) => check === focused && check.evidence.length
    ? `${check.reason}: ${check.evidence.join(", ")}`
    : check.reason);
  const reason = reasons.length ? reasons.join("; ") : det.reason;
  const state = failing.length ? "needs-author-update" : det.state;
  const rendered = render(state, { humanGated: evaluated.focusedUnresolved });
  return enforceMirrorCommentBound(withChecks({ ...rendered, mirror: !evaluated.focusedUnresolved, duplicate: false, close: false, confidence, degraded: null, reason }, checks, ctx));
}

export function degradedVerdict(reason: string): RenderOutput {
  return { ...render("stale-unknown"), mirror: false, duplicate: false, close: false, confidence: "unknown", degraded: "error", checks: [], reason, nextAction: "Retry when data is available", actor: "system", feedback: "" };
}

export interface MirrorRequest {
  repo: string;
  number: number;
  labels: string[];
  owned: readonly string[];
  comment: string;
  close: boolean;
}

export type Verdict = RenderOutput & { repo: string; number: number; headSha: string | null; workflowVersion: number; request: MirrorRequest; cleanupMode?: CleanupMode; actions: SuggestedAction[] };

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
