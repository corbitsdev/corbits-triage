// A refused policy file's schema errors said in the file's terms: what each value must be, the key a mistyped one was
// meant to be, and for a step, the kinds and targets it takes. `rules` keeps the schema's own messages.
import { asRecord } from "@corbits/common";
import { AUTHOR_KINDS, CI_STATES, DECIDE_KINDS, GROUP_NAME_MAX, LABEL_MAX, ON_FAILS, POLICY_EVENTS, STEP_KINDS, VERDICTS } from "./check-pack.js";
import { BLOCK_KINDS, BLOCK_OUTCOMES, closest, pathText, PROVIDERS, SEVERITIES, type PathProblem } from "./policy-workflow.js";

const BLOCK = Symbol("block");
const VERDICT = Symbol("verdict");
const NAME = Symbol("name");
const INDEX = Symbol("index");
type Segment = string | typeof BLOCK | typeof VERDICT | typeof NAME | typeof INDEX;
type Pattern = readonly Segment[];

/** A mapping's own message, from the keys the entries under it name. */
const MAPPING = Symbol("mapping");

function words(values: readonly string[], last = "or"): string {
  return values.length === 1 ? values[0]! : `${values.slice(0, -1).join(", ")} ${last} ${values.at(-1)}`;
}

function quoted(values: readonly string[]): string[] {
  return values.map((value) => `\`${value}\``);
}

const VERDICTS_TEXT = `${words(VERDICTS)}, or a list of them`;
const GROUPS_TEXT = `a list of group names, each lowercase words joined by hyphens, at most ${GROUP_NAME_MAX} characters`;
const SEVERITY_TEXT = words(SEVERITIES);
const DURATION_TEXT = "a duration of at least 1, such as 30s, 2m, 24h or 7d";
const COUNT_TEXT = "a whole number of at least 1";
const LABEL_TEXT = `a label of at most ${LABEL_MAX} characters`;


/**
 * What each value must be; a list marked `exact` says only what the list itself must be, its items saying their own.
 * The keys a mapping takes are the keys its entries name.
 */
const EXPECTED: ReadonlyArray<readonly [Pattern, string | typeof MAPPING, "exact"?]> = [
  [["extends"], "a repository written owner/name, or a workspace policy's id"],
  [["onFail"], words(ON_FAILS)],
  [["rules"], "a list of rules", "exact"],
  [["actions"], MAPPING],
  [["actions", "on"], `a list of ${words(POLICY_EVENTS)}`],
  [["actions", VERDICT], "a list of steps", "exact"],
  [["labels"], MAPPING],
  [["labels", VERDICT], LABEL_TEXT],
  [["groups"], "a mapping of group names to who is in them"],
  [["groups", NAME], MAPPING],
  [["groups", NAME, "association"], `a list of ${words(AUTHOR_KINDS)}`],
  [["groups", NAME, "teams"], "a list of teams written org/team"],
  [["groups", NAME, "users"], "a list of logins"],
  [[BLOCK], MAPPING],
  [[BLOCK, "on"], "true or false"],
  [[BLOCK, "for"], GROUPS_TEXT],
  [[BLOCK, "when"], MAPPING],
  [[BLOCK, "when", "triage"], VERDICTS_TEXT],
  [[BLOCK, "when", "paths"], "a list of globs with no spaces at either end, where `!` right before a glob leaves out the files it matches"],
  [[BLOCK, "clean"], MAPPING],
  [[BLOCK, "clean", "below"], SEVERITY_TEXT],
  [[BLOCK, "clean", "minConfidence"], "a number from 0 to 1"],
  [[BLOCK, "clean", "coverage"], "full"],
  [[BLOCK, "provider"], words(PROVIDERS)],
  [["pace"], MAPPING],
  [["pace", "debounce"], DURATION_TEXT],
  [["pace", "maxWait"], DURATION_TEXT],
  [["pace", "perHead"], COUNT_TEXT],
  [["pace", "cap"], MAPPING],
  [["pace", "cap", "runs"], COUNT_TEXT],
  [["pace", "cap", "per"], DURATION_TEXT],
  [["pace", "backoff"], MAPPING],
  [["pace", "backoff", "pushes"], COUNT_TEXT],
  [["pace", "backoff", "within"], DURATION_TEXT],
  [["pace", "backoff", "pause"], DURATION_TEXT],
  [["pauseLabel"], LABEL_TEXT],
  [["decide"], "a list of rules, each { if, do }", "exact"],
  [["decide", INDEX], MAPPING],
  [["decide", INDEX, "if"], "a mapping of conditions"],
  [["decide", INDEX, "if", "all"], "clean"],
  [["decide", INDEX, "if", "triage"], VERDICTS_TEXT],
  [["decide", INDEX, "if", "event"], `a list of ${words(POLICY_EVENTS)}`],
  [["decide", INDEX, "if", "author"], GROUPS_TEXT],
  [["decide", INDEX, "if", BLOCK], `${words(BLOCK_OUTCOMES)}, a list of them, or { findings: <severity> } with a severity of ${SEVERITY_TEXT}`],
  [["decide", INDEX, "do"], `one of ${words(quoted(DECIDE_KINDS))}, or a list of them`, "exact"],
];

function segmentMatches(segment: Segment, key: PropertyKey): boolean {
  if (segment === INDEX) return typeof key === "number";
  if (segment === NAME) return typeof key === "string";
  if (segment === BLOCK) return (BLOCK_KINDS as readonly PropertyKey[]).includes(key);
  if (segment === VERDICT) return (VERDICTS as readonly PropertyKey[]).includes(key);
  return segment === key;
}

function matches(pattern: Pattern, path: readonly PropertyKey[]): boolean {
  return pattern.length === path.length && pattern.every((segment, at) => segmentMatches(segment, path[at]!));
}

function segmentKeys(segment: Segment): readonly string[] {
  if (segment === BLOCK) return BLOCK_KINDS;
  if (segment === VERDICT) return VERDICTS;
  return typeof segment === "string" ? [segment] : [];
}

/** The keys the mapping at `path` takes, from the entries under it; none for a list or a mapping of names. */
function keysAt(path: readonly PropertyKey[]): string[] {
  return EXPECTED.flatMap(([pattern]) => (pattern.length === path.length + 1 && matches(pattern.slice(0, -1), path) ? segmentKeys(pattern.at(-1)!) : []));
}

function expectedAt(path: readonly PropertyKey[], whole: boolean): string | undefined {
  const found = EXPECTED.find(([pattern, , exact]) => matches(pattern, path) && (exact === undefined || whole));
  if (!found) return undefined;
  return found[1] === MAPPING ? `a mapping of ${words(keysAt(path), "and")}` : found[1];
}

type Problem = PathProblem & { suggested?: string };

function unknownKey(path: readonly PropertyKey[], allowed: readonly string[]): Problem {
  const suggestion = closest(String(path.at(-1)), allowed);
  if (suggestion === undefined) return { message: `\`${pathText(path)}\` is not a key; use ${words(allowed)}.`, path };
  const meant = [...path.slice(0, -1), suggestion];
  return { message: `\`${pathText(path)}\` is not a key; did you mean \`${pathText(meant)}\`?`, path, suggested: pathText(meant) };
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let node = root;
  for (const key of path) node = node !== null && typeof node === "object" ? (node as Record<PropertyKey, unknown>)[key] : undefined;
  return node;
}

const TARGET_EXAMPLES: Record<string, string> = {
  comment: "{ body: … }",
  labels: "{ from: list, labels: [ … ] }",
  "request-review": "{ to: codeowners }",
  assign: "{ to: author }",
};
const TARGETS: Record<string, string> = {
  comment: "`{ body: … }`",
  labels: "`{ from: list, labels: [ … ] }` or `{ from: rules }`",
  "request-review": "`{ to: codeowners }`, `{ to: users, users: [ … ] }` or `{ to: teams, teams: [ … ] }`",
  assign: "`{ to: codeowners }`, `{ to: users, users: [ … ] }`, `{ to: teams, teams: [ … ] }` or `{ to: author }`",
};
const STEP_KEYS = ["do", "target", "when"];
const WHEN: Record<string, string> = {
  author: `a list of ${quoted(AUTHOR_KINDS).join(", ")}, group names, \`everyone\`, \`{ team: org/team }\` or \`{ users: [ … ] }\``,
  linkedIssue: "`true` or `false`",
  ci: `a list of ${words(quoted(CI_STATES))}`,
  files: "`{ over: N, atMost: M }`, either or both",
  lines: "`{ over: N, atMost: M }`, either or both",
};

type StepAt = { root: readonly PropertyKey[]; kinds: readonly string[]; value: unknown };

/** The step an error is in: one under `actions`, or one in a `decide` rule's `do`. */
function stepOf(path: readonly PropertyKey[], file: unknown): StepAt | undefined {
  if (path[0] === "actions" && (VERDICTS as readonly PropertyKey[]).includes(path[1]!) && typeof path[2] === "number") {
    const root = path.slice(0, 3);
    return { root, kinds: STEP_KINDS, value: valueAt(file, root) };
  }
  if (path[0] !== "decide" || typeof path[1] !== "number" || path[2] !== "do") return undefined;
  const root = typeof path[3] === "number" ? path.slice(0, 4) : path.slice(0, 3);
  const value = valueAt(file, root);
  return root.length === 4 || typeof value === "string" ? { root, kinds: DECIDE_KINDS, value } : undefined;
}

function kindProblem(path: readonly PropertyKey[], kinds: readonly string[], written: unknown): Problem {
  const suggestion = typeof written === "string" ? closest(written, kinds) : undefined;
  const hint = suggestion === undefined ? "." : `; did you mean \`${suggestion}\`?`;
  return { message: `\`${pathText(path)}\` must be one of ${words(quoted(kinds))}${hint}`, path };
}

function needsTarget(path: readonly PropertyKey[], kind: string): Problem {
  return { message: `\`${pathText(path)}\` \`${kind}\` needs a target; write \`{ do: ${kind}, target: ${TARGET_EXAMPLES[kind]} }\`.`, path };
}

function wholeStepProblems({ root, kinds, value }: StepAt): Problem[] {
  if (typeof value === "string") return [Object.hasOwn(TARGETS, value) ? needsTarget(root, value) : kindProblem(root, kinds, value)];
  const step = asRecord(value);
  if (!step) return [{ message: `\`${pathText(root)}\` must be a step \`{ do, target, when }\`${kinds === STEP_KINDS ? "" : ` or one of ${words(quoted(DECIDE_KINDS.filter((kind) => !Object.hasOwn(TARGETS, kind))))}`}.`, path: root }];
  const unknown = Object.keys(step).filter((key) => !STEP_KEYS.includes(key));
  if (unknown.length > 0) return unknown.map((key) => unknownKey([...root, key], STEP_KEYS));
  return [kindProblem([...root, "do"], kinds, step.do)];
}

function stepProblems(step: StepAt, rel: readonly PropertyKey[], code: string, problem: string, message: string): Problem[] {
  const { root, kinds, value } = step;
  const written = asRecord(value)?.do;
  const kind = String(written);
  const removed = problem === "must be removed";
  if (rel.length === 0) return wholeStepProblems(step);
  if (rel[0] === "do") return [kindProblem([...root, "do"], kinds, written)];
  if (rel[0] === "target") {
    if (rel.length === 1 && removed) return [{ message: `\`${pathText([...root, "target"])}\` must be removed; \`${kind}\` takes no target.`, path: [...root, "target"] }];
    if (rel.length === 1 && code === "required") return [needsTarget(root, kind)];
    return [{ message: `\`${pathText([...root, "target"])}\` must be ${TARGETS[kind]}.`, path: [...root, "target"] }];
  }
  if (rel[0] === "when" && rel.length === 1) return [{ message: `\`${pathText([...root, "when"])}\` must be a mapping of ${words(Object.keys(WHEN), "and")}.`, path: [...root, "when"] }];
  if (rel[0] === "when" && rel.length === 2 && removed) return [unknownKey([...root, ...rel], Object.keys(WHEN))];
  if (rel[0] === "when" && Object.hasOwn(WHEN, String(rel[1]))) return [{ message: `\`${pathText([...root, ...rel.slice(0, 2)])}\` must be ${WHEN[String(rel[1])]}.`, path: [...root, ...rel.slice(0, 2)] }];
  if (rel.length === 1 && removed) return [unknownKey([...root, ...rel], STEP_KEYS)];
  return [{ message, path: [...root, ...rel] }];
}

type SchemaError = { path: readonly PropertyKey[]; code: string; problem: string; message: string };

function errorProblems({ path, code, problem, message }: SchemaError, file: unknown): Problem[] {
  const step = stepOf(path, file);
  if (step) return stepProblems(step, path.slice(step.root.length), code, problem, message);
  if (problem === "must be removed") {
    const allowed = keysAt(path.slice(0, -1));
    if (allowed.length > 0) return [unknownKey(path, allowed)];
  }
  for (let end = path.length; end >= 0; end--) {
    if (path.slice(end).some((key) => typeof key !== "number")) break;
    const at = path.slice(0, end);
    const expected = expectedAt(at, end === path.length);
    if (expected !== undefined) return [{ message: `\`${pathText(at)}\` must be ${expected}.`, path: at }];
  }
  return [{ message, path }];
}

/**
 * Each schema error as a problem in the file's terms, each said once. A key missing because it was mistyped is said only
 * as the mistyped key.
 */
export function fileProblems(errors: Iterable<SchemaError>, file: unknown): PathProblem[] {
  const all = [...errors].map((error) => ({ error, problems: errorProblems(error, file) }));
  const meant = new Set(all.flatMap(({ problems }) => problems.flatMap((problem) => (problem.suggested === undefined ? [] : [problem.suggested]))));
  const kept = all.flatMap(({ error, problems }) => (error.code === "required" && meant.has(pathText(error.path)) ? [] : problems));
  const once = new Map(kept.map(({ message, path }) => [message, { message, path }]));
  return [...once.values()];
}
