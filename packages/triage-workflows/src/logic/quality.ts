import type { ModelCustomCheck, QualityCheckId } from "@corbits/triage-contracts";
import type { DeterministicResult, PrFacts } from "./checks.js";
import { extractChangeCandidates, type ChangeCandidate } from "./candidates.js";

interface BooleanQualityQuestion {
  id: string;
  type: "boolean";
  instructions: string;
}

interface ChoiceQualityQuestion {
  id: string;
  type: "choice";
  instructions: string;
  criteria: Record<FocusedChoice, string>;
}

export type QualityQuestion = BooleanQualityQuestion | ChoiceQualityQuestion;

export const FOCUSED_CHOICES = ["primary_or_supporting", "unrelated", "movement_or_superseded", "ambiguous"] as const;
export type FocusedChoice = typeof FOCUSED_CHOICES[number];

const FOCUSED_CRITERIA: Record<FocusedChoice, string> = {
  primary_or_supporting: "The candidate is the primary change or directly supports the primary change.",
  unrelated: "The candidate is a separate purpose that should be split into another pull request.",
  movement_or_superseded: "The candidate only moves, renames, deletes, or supersedes code as part of the primary change.",
  ambiguous: "The available evidence is insufficient to classify the candidate safely.",
};

/** Each question is answered true when the pull request passes the check. */
const INSTRUCTIONS: Record<QualityCheckId, string> = {
  focused: "Does this pull request make one focused change rather than mixing unrelated changes?",
  docs: "If this pull request changes user-facing behavior, configuration, or a public API, does it update the documentation? Answer true when no documentation change is needed.",
  tests: "If this pull request changes runtime behavior, does it add or update tests? Answer true when no test change is needed.",
};

const FAILURES: Record<QualityCheckId, string> = {
  focused: "mixes unrelated changes",
  docs: "documentation is not updated",
  tests: "tests are not added or updated",
};

const ACTIONS: Record<QualityCheckId, string> = {
  focused: "Split out unrelated changes",
  docs: "Update the documentation",
  tests: "Add or update tests",
};

const PASSES: Record<QualityCheckId, string> = {
  focused: "makes one focused change",
  docs: "documentation is up to date",
  tests: "tests cover the change",
};

const MAX_BODY = 4000;
const MAX_PATHS = 200;
const MAX_COMMITS = 50;
// Neither @corbits/system-one 0.3.1 (adapter.js, client.js) nor @intx/inference bounds a request, so these are our own conservative bounds on one Jev evaluation.
export const MAX_SYSTEM_ONE_CONTEXT_BYTES = 30_000;
export const MAX_SYSTEM_ONE_REQUEST_CONTENT_BYTES = 60_000;
export const MAX_SYSTEM_ONE_QUESTIONS = 32;
export const QUALITY_EVALUATION_LIMIT_ERROR = "pull request too large for the decision model";

/** The judge answers yes or no, so every shape is asked as a pass question. */
function customInstructions(row: ModelCustomCheck): string {
  switch (row.shape) {
    case "is-true":
      return `${row.name}: ${row.claim} Answer true when the pull request meets this.`;
    case "score":
      return `${row.name}: On a scale of 0 to 10, does the pull request score at least ${row.min} for ${row.subject}? Answer true when it does.`;
    case "choose":
      return `${row.name}: Which of ${row.options.join(", ")} describes the pull request? Answer false when it is ${row.failOn.join(" or ")}, true otherwise.`;
  }
}

export function focusedCandidateId(index: number): string {
  return `focused-candidate-${String(index + 1).padStart(3, "0")}`;
}

function focusedQuestion(candidate: ChangeCandidate, index: number): ChoiceQualityQuestion {
  const id = focusedCandidateId(index);
  return {
    id,
    type: "choice",
    instructions: `Classify changeCandidates.${id}. Direct support required by the primary change is primary_or_supporting, not unrelated. Pure movement, rename, deletion, or superseded code is movement_or_superseded, not unrelated. Choose unrelated only for a separate purpose; choose ambiguous when the evidence cannot decide. Candidate label: ${candidate.label}.`,
    criteria: FOCUSED_CRITERIA,
  };
}

export function qualityQuestions(sources: NonNullable<DeterministicResult["sources"]>, candidates: readonly ChangeCandidate[] = []): QualityQuestion[] {
  const quality: QualityQuestion[] = [];
  for (const { id } of sources.quality) {
    // A candidate without evidence resolves unconfirmed whatever the answer, so it is not asked.
    if (id === "focused") quality.push(...candidates.flatMap((candidate, index) => (candidate.evidence ? [focusedQuestion(candidate, index)] : [])));
    else quality.push({ id, type: "boolean", instructions: INSTRUCTIONS[id] });
  }
  return [
    ...quality,
    ...sources.custom.map((row) => ({ id: row.id, type: "boolean" as const, instructions: customInstructions(row) })),
  ];
}

type Entry = readonly [index: number, candidate: ChangeCandidate];

export function qualityState(facts: PrFacts, candidates?: readonly Entry[]) {
  const state = {
    title: facts.title,
    body: (facts.body ?? "").slice(0, MAX_BODY),
    commits: (facts.commits ?? []).slice(0, MAX_COMMITS),
    paths: (facts.paths ?? []).slice(0, MAX_PATHS),
    changedFiles: facts.changedFiles,
    additions: facts.additions,
    deletions: facts.deletions,
  };
  if (candidates === undefined) return state;
  return {
    ...state,
    changeCandidates: Object.fromEntries(candidates.map(([index, candidate]) => [focusedCandidateId(index), candidate])),
  };
}

function customCheck(id: string, sources: NonNullable<DeterministicResult["sources"]>) {
  return sources.custom.find((c) => c.id === id);
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** One System One call: the same pull request metadata with a share of the questions. */
export interface JudgeRequest {
  state: ReturnType<typeof qualityState>;
  questions: QualityQuestion[];
  measurements: { contextBytes: number; requestContentBytes: number };
}

export interface QualityEvaluation {
  /** Every candidate in file order; one too large to ask alone carries trimmed evidence. */
  candidates: ChangeCandidate[];
  requests: JudgeRequest[];
  judgeError?: string;
}

function judgeRequest(facts: PrFacts, focused: boolean, base: QualityQuestion[], entries: readonly Entry[]): JudgeRequest {
  const state = qualityState(facts, focused ? entries : undefined);
  const questions = [...base, ...entries.map(([index, candidate]) => focusedQuestion(candidate, index))];
  const contextBytes = jsonBytes(state) + questions.reduce((longest, question) => Math.max(longest, jsonBytes(question)), 0);
  return { state, questions, measurements: { contextBytes, requestContentBytes: jsonBytes({ state, questions }) } };
}

function fits({ questions, measurements }: JudgeRequest): boolean {
  return questions.length <= MAX_SYSTEM_ONE_QUESTIONS &&
    measurements.contextBytes <= MAX_SYSTEM_ONE_CONTEXT_BYTES &&
    measurements.requestContentBytes <= MAX_SYSTEM_ONE_REQUEST_CONTENT_BYTES;
}

/** Keeps the most leading evidence lines that fit one request alone; with none, the candidate is not asked. */
function trimToFit(candidate: ChangeCandidate, fitsAlone: (candidate: ChangeCandidate) => boolean): ChangeCandidate {
  const lines = candidate.evidence.split("\n");
  const withLines = (count: number): ChangeCandidate => ({ ...candidate, evidence: lines.slice(0, count).join("\n"), trimmed: true });
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsAlone(withLines(middle))) low = middle;
    else high = middle - 1;
  }
  return withLines(low);
}

/**
 * Splits one evaluation into System One requests under the budget, a pure function of the facts: the first carries every
 * non-candidate question and as many candidates as fit in file order, later ones the rest. Only an evaluation whose
 * non-candidate questions and metadata do not fit alone is refused.
 */
export function prepareQualityEvaluation(facts: PrFacts, sources: DeterministicResult["sources"]): QualityEvaluation {
  const candidates = extractChangeCandidates(facts.files);
  if (!sources) return { candidates, requests: [] };
  const focused = sources.quality.some((source) => source.id === "focused");
  const base = qualityQuestions(sources);
  if (!fits(judgeRequest(facts, focused, base, []))) return { candidates, requests: [], judgeError: QUALITY_EVALUATION_LIMIT_ERROR };

  const requests: JudgeRequest[] = [];
  let pending = base;
  let entries: Entry[] = [];
  for (const [index, extracted] of (focused ? candidates : []).entries()) {
    if (!extracted.evidence) continue;
    if (fits(judgeRequest(facts, focused, pending, [...entries, [index, extracted]]))) {
      entries.push([index, extracted]);
      continue;
    }
    if (pending.length > 0 || entries.length > 0) requests.push(judgeRequest(facts, focused, pending, entries));
    pending = [];
    entries = [];
    const alone = (candidate: ChangeCandidate) => fits(judgeRequest(facts, focused, [], [[index, candidate]]));
    const candidate = alone(extracted) ? extracted : trimToFit(extracted, alone);
    candidates[index] = candidate;
    if (candidate.evidence) entries.push([index, candidate]);
  }
  if (pending.length > 0 || entries.length > 0) requests.push(judgeRequest(facts, focused, pending, entries));
  return { candidates, requests };
}

export function failureText(id: string, sources: NonNullable<DeterministicResult["sources"]>): string {
  if (id in FAILURES) return FAILURES[id as QualityCheckId];
  const custom = customCheck(id, sources);
  return custom ? `does not meet "${custom.name}"` : `does not pass ${id}`;
}

export function actionText(id: string, sources: NonNullable<DeterministicResult["sources"]>): string {
  if (id in ACTIONS) return ACTIONS[id as QualityCheckId];
  const custom = customCheck(id, sources);
  return custom ? `Meet "${custom.name}"` : `Pass ${id}`;
}

export function passText(id: string, sources: NonNullable<DeterministicResult["sources"]>): string {
  if (id in PASSES) return PASSES[id as QualityCheckId];
  const custom = customCheck(id, sources);
  return custom ? `meets "${custom.name}"` : `passes ${id}`;
}
