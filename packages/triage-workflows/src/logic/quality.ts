import { isDocPath, isGeneratedPath, isTestPath, type CheckItem, type ModelCustomCheck, type QualityCheckId } from "@corbits/triage-contracts";
import type { DeterministicResult, PrFacts } from "./checks.js";
import { boundedPath, extractChangeCandidates, hunkCitations, patchHunks, type ChangeCandidate } from "./candidates.js";
import { globMatch } from "./glob.js";

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

// Docs and tests are decided per file and combined in code: changing a doc or test file passes them, otherwise each file
// gets one direct question. Jev answers conditional questions ("if X, does it Y?") backwards, so none is asked.
type FileCheck = "docs" | "tests";

/** Each question is answered yes when the file needs what the check asks for. */
const FILE_QUESTIONS: Record<FileCheck, (file: number) => string> = {
  tests: (file) => `Does the change in \`pullRequest.files[${file}]\` change runtime behavior, meaning code that runs, as opposed to tests, docs, comments, formatting, or styling?`,
  docs: (file) => `Does the change in \`pullRequest.files[${file}]\` make a statement in \`repository.docs\` wrong or incomplete, or add setup, configuration, permissions, or commands that \`repository.docs\` must describe?`,
};

/** The file kind that satisfies the check by being changed. */
const SATISFIES: Record<FileCheck, (path: string) => boolean> = { tests: isTestPath, docs: isDocPath };

/** Only a change outside tests and docs can need either. */
function isAsked(path: string): boolean {
  return !isTestPath(path) && !isDocPath(path);
}

function ordinal(index: number): string {
  return String(index + 1).padStart(3, "0");
}

function fileQuestionId(check: string, file: number): string {
  return `${check}-file-${ordinal(file)}`;
}

function hunkQuestionId(check: string, file: number, hunk: number): string {
  return `${check}-hunk-${ordinal(file)}-${ordinal(hunk)}`;
}

export type ScopedCheck = ModelCustomCheck & { shape: "is-true"; scope: "file" | "hunk" };

/** A custom check asked once per changed file or hunk in its scope rather than once for the whole pull request. */
export function isScoped(row: ModelCustomCheck): row is ScopedCheck {
  return row.shape === "is-true" && (row.scope === "file" || row.scope === "hunk");
}

function inScope(row: ScopedCheck, path: string): boolean {
  return row.when === undefined || row.when.some((glob) => globMatch(path, glob));
}

/** A rule is a statement; its closing punctuation would end the question early. */
function ruleText(row: ScopedCheck): string {
  return row.claim.replace(/[.!?]+$/, "");
}

/** How a per-file check is decided for one pull request: docs, tests, or a file or hunk scoped custom check. */
export interface FilePlan {
  /** Changed files that satisfy the check; any one passes it without asking. */
  changed: string[];
  /** Question id to the file, or the lines of the hunk within it, it asks about. */
  asked: Record<string, CheckItem>;
  /** Files or hunks the check would ask about but no request could read, such as patches GitHub left out. */
  unread: string[];
}

/** Keyed by check id. */
export type QualityPlan = Record<string, FilePlan>;

/** One question about one changed file or hunk, asked of whichever request holds the file at index `file`. */
interface FileQuestion {
  check: string;
  id: string;
  item: CheckItem;
  instructions: (file: number) => string;
}

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

// Custom checks are the repository's own rules, so their requests carry its contribution rules and say where they are.
const AGAINST_RULES = "Judge it by the pull request and the repository's contribution rules in `repository.rules`.";

/** Every shape is asked as one direct question a yes answer passes. */
function customInstructions(row: ModelCustomCheck): string {
  return `${customQuestion(row)} ${AGAINST_RULES}`;
}

function customQuestion(row: ModelCustomCheck): string {
  switch (row.shape) {
    case "is-true":
      return `${row.name}: ${row.claim}`;
    case "score":
      return `${row.name}: Does the pull request reach at least ${row.min} out of 10 for ${row.subject}?`;
    case "choose": {
      const passing = row.options.filter((option) => !row.failOn.includes(option));
      const failing = row.failOn.join(" or ");
      if (passing.length === 0) return `${row.name}: Is the pull request best described as something other than ${failing}?`;
      return `${row.name}: Is the pull request best described as ${passing.join(" or ")}, rather than ${failing}?`;
    }
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

function customQuestions(sources: NonNullable<DeterministicResult["sources"]>): QualityQuestion[] {
  return sources.custom.filter((row) => !isScoped(row)).map((row) => ({ id: row.id, type: "boolean" as const, instructions: customInstructions(row) }));
}

/** Every question id an evaluation asks; `render` refuses answers to anything else. */
export function askedQuestionIds(sources: NonNullable<DeterministicResult["sources"]>, candidates: readonly ChangeCandidate[], plan: QualityPlan): Set<string> {
  // A candidate without evidence resolves unconfirmed whatever the answer, so it is not asked.
  const candidateIds = isFocused(sources) ? candidates.flatMap((candidate, index) => (candidate.evidence ? [focusedCandidateId(index)] : [])) : [];
  return new Set([...candidateIds, ...customQuestions(sources).map((question) => question.id), ...Object.values(plan).flatMap((filePlan) => Object.keys(filePlan.asked))]);
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
  /** `rules` are the contribution rules, given only to requests that ask custom checks, and left out of their `docs`. */
  repository: { docs: Record<string, string>; rules?: Record<string, string> };
};

function judgeState(facts: PrFacts, files: StateFile[], withRules: boolean): JudgeState {
  return {
    pullRequest: {
      title: facts.title,
      body: (facts.body ?? "").slice(0, MAX_BODY),
      commits: (facts.commits ?? []).slice(0, MAX_COMMITS),
      paths: (facts.paths ?? []).slice(0, MAX_PATHS),
      files,
    },
    repository: withRules ? withContributionRules(facts.docs ?? {}, facts.rules ?? {}) : { docs: facts.docs ?? {} },
  };
}

function withContributionRules(docs: Record<string, string>, rules: Record<string, string>): JudgeState["repository"] {
  return { docs: Object.fromEntries(Object.entries(docs).filter(([path]) => !(path in rules))), rules };
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
  plan: QualityPlan;
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
  if (!sources) return { candidates, plan: {}, requests: [] };
  const enabled = new Set(sources.quality.map((source) => source.id));
  const plan: QualityPlan = {};
  for (const check of ["tests", "docs"] as const) {
    // Deleting a test or doc does not cover a change.
    const changed = (facts.files ?? []).filter((file) => file.status !== "removed" && SATISFIES[check](file.path));
    if (enabled.has(check)) plan[check] = { changed: changed.map((file) => file.path), asked: {}, unread: [] };
  }
  const scoped = sources.custom.filter(isScoped);
  for (const row of scoped) plan[row.id] = { changed: [], asked: {}, unread: [] };
  const room = MAX_SYSTEM_ONE_STATE_BYTES - jsonBytes(judgeState(facts, [], false));
  const rulesRoom = MAX_SYSTEM_ONE_STATE_BYTES - jsonBytes(judgeState(facts, [], true));
  if (room < 0 || (sources.custom.length > 0 && rulesRoom < 0)) return { candidates, plan, requests: [], judgeError: QUALITY_EVALUATION_LIMIT_ERROR };

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
  let questions: QualityQuestion[] = customQuestions(sources);
  let asksCustom = questions.length > 0;

  // State without questions tells the judge nothing, so only requests that ask something are made.
  function flush() {
    if (questions.length > 0) requests.push({ state: judgeState(facts, chunk, asksCustom), questions });
    chunk = [];
    used = 0;
    questions = [];
    asksCustom = false;
  }

  function add(file: StateFile, bytes: number) {
    used += bytes + (chunk.length > 0 ? 1 : 0);
    chunk.push(file);
  }

  /** Starts a new request that reads `file` again when this one holds as many questions as one request may ask. */
  function makeRoom(file: StateFile, bytes: number) {
    if (questions.length < MAX_SYSTEM_ONE_QUESTIONS) return;
    flush();
    add(file, bytes);
  }

  /** The checks a rule has not already passed that ask about this file. */
  function fileChecks(path: string): FileCheck[] {
    if (!isAsked(path)) return [];
    return (["tests", "docs"] as const).filter((check) => plan[check]?.changed.length === 0);
  }

  /** Every question about the file at `position` whose leading `read` hunks the request holds; a patch without hunk headers is cited as its file. */
  function fileQuestions(path: string, position: number, read: number, cited: CheckItem[]): FileQuestion[] {
    const out: FileQuestion[] = fileChecks(path).map((check) => ({ check, id: fileQuestionId(check, position), item: path, instructions: FILE_QUESTIONS[check] }));
    for (const row of scoped) {
      if (!inScope(row, path)) continue;
      if (row.scope === "file") {
        out.push({ check: row.id, id: fileQuestionId(row.id, position), item: path, instructions: (file) => `Does the change in \`pullRequest.files[${file}]\` meet this rule: ${ruleText(row)}? ${AGAINST_RULES}` });
        continue;
      }
      // Uncapped: every hunk read is one question per hunk-scoped check, so a wide diff spreads over many judge requests.
      for (let hunk = 0; hunk < read; hunk++) {
        out.push({ check: row.id, id: hunkQuestionId(row.id, position, hunk), item: cited[hunk] ?? path, instructions: (file) => `Does the change in \`pullRequest.files[${file}].hunks[${hunk}]\` meet this rule: ${ruleText(row)}? ${AGAINST_RULES}` });
      }
    }
    return out;
  }

  for (const [position, file] of files.entries()) {
    const path = boundedPath(file.path);
    const hunks = typeof file.patch === "string" ? patchHunks(file.patch) : [];
    const read: StateFile = { path, ...(file.status ? { status: file.status } : {}), hunks, ...(file.patchTruncated ? { truncated: true as const } : {}) };
    const custom = scoped.some((row) => inScope(row, file.path));
    const fitted = hunks.length > 0 ? fitFile(custom || (asksCustom && chunk.length === 0) ? rulesRoom : room, read) : undefined;
    if (!fitted) {
      // A pure rename or a binary file has no lines to read, so there is nothing to judge.
      const unchanged = file.additions === 0 && file.deletions === 0;
      if (!unchanged) {
        for (const check of fileChecks(file.path)) plan[check]!.unread.push(file.path);
        for (const row of scoped) if (inScope(row, file.path)) plan[row.id]!.unread.push(file.path);
      }
      continue;
    }
    // Lines left out of a file may break a custom rule, so a scoped check cannot pass on what was read.
    if (fitted.truncated) for (const row of scoped) if (inScope(row, file.path)) plan[row.id]!.unread.push(file.path);
    const asking = fileQuestions(file.path, position, fitted.hunks.length, typeof file.patch === "string" ? hunkCitations(file.path, file.patch, file.previousPath) : []);
    const bytes = jsonBytes(fitted);
    const owned = owners.get(path) ?? [];
    if (chunk.length > 0 && (used + 1 + bytes > (custom || asksCustom ? rulesRoom : room) || questions.length + asking.length + owned.length > MAX_SYSTEM_ONE_QUESTIONS)) flush();
    add(fitted, bytes);
    for (const question of asking) {
      makeRoom(fitted, bytes);
      questions.push({ id: question.id, type: "boolean", instructions: question.instructions(chunk.length - 1) });
      plan[question.check]!.asked[question.id] = question.item;
      if (question.check !== "tests" && question.check !== "docs") asksCustom = true;
    }
    for (const [index, candidate] of owned) {
      if ((candidate.hunk ?? 0) >= fitted.hunks.length) continue;
      makeRoom(fitted, bytes);
      questions.push(focusedQuestion(candidate, index, chunk.length - 1));
      asked.add(index);
    }
  }
  flush();
  // A candidate no request could hold reads as one without evidence, so focused lists its file unread.
  return { candidates: candidates.map((candidate, index) => (asked.has(index) || !candidate.evidence ? candidate : { ...candidate, evidence: "" })), plan, requests };
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
