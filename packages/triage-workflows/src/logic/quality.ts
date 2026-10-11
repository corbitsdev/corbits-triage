import { isGeneratedPath, type ModelCustomCheck, type QualityCheckId } from "@corbits/triage-contracts";
import type { DeterministicResult, PrFacts } from "./checks.js";
import { boundedPath, extractChangeCandidates, patchHunks, type ChangeCandidate } from "./candidates.js";

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
// Jev caps a request's state at about 32k tokens, roughly 105 KB of diff; questions do not count toward it.
export const MAX_SYSTEM_ONE_STATE_BYTES = 90_000;
// No cap is documented; requests of 300 questions were answered whole.
export const MAX_SYSTEM_ONE_QUESTIONS = 256;
export const QUALITY_EVALUATION_LIMIT_ERROR = "pull request too large for the decision model";

/** Lockfiles say nothing the judge decides on, so it never reads them. */
function judgedFiles(facts: PrFacts) {
  return (facts.files ?? []).filter((file) => !isGeneratedPath(file.path));
}

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

/** `file` is the candidate's index among the request's files, which hold its hunk. */
function focusedQuestion(candidate: ChangeCandidate, index: number, file: number): ChoiceQualityQuestion {
  return {
    id: focusedCandidateId(index),
    type: "choice",
    instructions: `Classify the change \`pullRequest.files[${file}].hunks[${candidate.hunk ?? 0}]\` (${candidate.label}) against the pull request's primary change. Direct support required by the primary change is primary_or_supporting, not unrelated. Pure movement, rename, deletion, or superseded code is movement_or_superseded, not unrelated. Choose unrelated only for a separate purpose; choose ambiguous when the evidence cannot decide.`,
    criteria: FOCUSED_CRITERIA,
  };
}

function isFocused(sources: NonNullable<DeterministicResult["sources"]>): boolean {
  return sources.quality.some((source) => source.id === "focused");
}

/** The whole-pull-request questions; focused is asked per candidate instead. */
function qualityQuestions(sources: NonNullable<DeterministicResult["sources"]>): QualityQuestion[] {
  return [
    ...sources.quality.flatMap(({ id }) => (id === "focused" ? [] : [{ id, type: "boolean" as const, instructions: INSTRUCTIONS[id] }])),
    ...sources.custom.map((row) => ({ id: row.id, type: "boolean" as const, instructions: customInstructions(row) })),
  ];
}

/** Every question id an evaluation of `candidates` asks; a candidate without evidence resolves unconfirmed whatever the answer, so it is not asked. */
export function qualityQuestionIds(sources: NonNullable<DeterministicResult["sources"]>, candidates: readonly ChangeCandidate[]): Set<string> {
  const asked = isFocused(sources) ? candidates.flatMap((candidate, index) => (candidate.evidence ? [focusedCandidateId(index)] : [])) : [];
  return new Set([...qualityQuestions(sources).map(({ id }) => id), ...asked]);
}

/** A changed file as the judge reads it: its patch split into the hunks candidates point at. */
export interface StateFile {
  path: string;
  status?: string;
  hunks: string[];
  /** Later hunks were left out. */
  truncated?: true;
}

// A type alias, not an interface, so it is assignable to System One's JSON state.
export type JudgeState = {
  pullRequest: {
    title: string;
    body: string;
    commits: string[];
    /** Every changed path, including files another request reads. */
    paths: string[];
    files: StateFile[];
  };
  repository: { docs: Record<string, string> };
};

function judgeState(facts: PrFacts, files: StateFile[]): JudgeState {
  return {
    pullRequest: {
      title: facts.title,
      body: (facts.body ?? "").slice(0, MAX_BODY),
      commits: (facts.commits ?? []).slice(0, MAX_COMMITS),
      paths: (facts.paths ?? []).slice(0, MAX_PATHS),
      files,
    },
    repository: { docs: facts.docs ?? {} },
  };
}

function customCheck(id: string, sources: NonNullable<DeterministicResult["sources"]>) {
  return sources.custom.find((c) => c.id === id);
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** One System One call: the pull request with a share of its files, and the questions about them. */
export interface JudgeRequest {
  state: JudgeState;
  questions: QualityQuestion[];
}

export interface QualityEvaluation {
  /** Every candidate in file order; one whose hunk no request could carry has no evidence. */
  candidates: ChangeCandidate[];
  requests: JudgeRequest[];
  judgeError?: string;
}

/** The file with as many leading hunks as fit in `room` bytes, or undefined when not even its first does. */
function fitFile(room: number, file: StateFile): StateFile | undefined {
  if (jsonBytes(file) <= room) return file;
  let bytes = jsonBytes({ ...file, hunks: [], truncated: true });
  let kept = 0;
  for (const hunk of file.hunks) {
    bytes += jsonBytes(hunk) + (kept > 0 ? 1 : 0);
    if (bytes > room) break;
    kept++;
  }
  return kept > 0 ? { ...file, hunks: file.hunks.slice(0, kept), truncated: true } : undefined;
}

/**
 * Splits one evaluation into System One requests, a pure function of the facts. Files fill each request's state in
 * order up to the budget; a file too large for one request alone keeps its leading hunks. The first request carries
 * every whole-pull-request question, and each request asks about the candidates whose hunks it holds. Only metadata too
 * large for one request is refused.
 */
export function prepareQualityEvaluation(facts: PrFacts, sources: DeterministicResult["sources"]): QualityEvaluation {
  const files = judgedFiles(facts);
  const candidates = extractChangeCandidates(files);
  if (!sources) return { candidates, requests: [] };
  const room = MAX_SYSTEM_ONE_STATE_BYTES - jsonBytes(judgeState(facts, []));
  if (room < 0) return { candidates, requests: [], judgeError: QUALITY_EVALUATION_LIMIT_ERROR };

  const owners = new Map<string, Array<[number, ChangeCandidate]>>();
  if (isFocused(sources)) {
    for (const [index, candidate] of candidates.entries()) {
      if (!candidate.evidence) continue;
      const owned = owners.get(candidate.path) ?? [];
      owned.push([index, candidate]);
      owners.set(candidate.path, owned);
    }
  }
  const asked = new Set<number>();
  const requests: JudgeRequest[] = [];
  let chunk: StateFile[] = [];
  let used = 0;
  let questions = qualityQuestions(sources);

  // State without questions tells the judge nothing, so only requests that ask something are made.
  function flush() {
    if (questions.length > 0) requests.push({ state: judgeState(facts, chunk), questions });
    chunk = [];
    used = 0;
    questions = [];
  }

  function add(file: StateFile, bytes: number) {
    used += bytes + (chunk.length > 0 ? 1 : 0);
    chunk.push(file);
  }

  for (const file of files) {
    if (typeof file.patch !== "string") continue;
    const path = boundedPath(file.path);
    const hunks = patchHunks(file.patch);
    if (hunks.length === 0) continue;
    const read: StateFile = { path, ...(file.status ? { status: file.status } : {}), hunks, ...(file.patchTruncated ? { truncated: true as const } : {}) };
    const fitted = fitFile(room, read);
    if (!fitted) continue;
    const bytes = jsonBytes(fitted);
    const owned = owners.get(path) ?? [];
    if (chunk.length > 0 && (used + 1 + bytes > room || questions.length + owned.length > MAX_SYSTEM_ONE_QUESTIONS)) flush();
    add(fitted, bytes);
    for (const [index, candidate] of owned) {
      if ((candidate.hunk ?? 0) >= fitted.hunks.length) continue;
      // A file with more candidates than one request may ask continues in the next request, which reads it again.
      if (questions.length >= MAX_SYSTEM_ONE_QUESTIONS) {
        flush();
        add(fitted, bytes);
      }
      questions.push(focusedQuestion(candidate, index, chunk.length - 1));
      asked.add(index);
    }
  }
  flush();
  // A candidate no request could hold reads as one without evidence, which leaves focused for a human.
  return { candidates: candidates.map((candidate, index) => (asked.has(index) || !candidate.evidence ? candidate : { ...candidate, evidence: "" })), requests };
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
