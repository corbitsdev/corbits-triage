import { type } from "arktype";
import { RE2JS, RE2JSSyntaxException } from "re2js";
import { asRecord, asRepo } from "@corbits/common";
import type { AuthorAssociation } from "./repo-policy.js";

export const CHECK_PACK_KIND = "corbits.triage.check-pack";
export const CHECK_PACK_SCHEMA_VERSION = 1;
export const CUSTOM_CHECK_CAP = 8;

export const CHECK_PACK_GROUPS = ["pull-request", "issue", "around", "code-vs-ci"] as const;
export type CheckPackGroup = (typeof CHECK_PACK_GROUPS)[number];

export const CATALOG_IDS = [
  "max-files-changed",
  "max-lines-changed",
  "focused",
  "docs",
  "linked-issue",
  "no-merge-conflicts",
  "ci-green",
  "no-forbidden-paths",
] as const;
export type CatalogId = (typeof CATALOG_IDS)[number];

export const QUALITY_CHECK_IDS = ["focused", "docs"] as const;
export type QualityCheckId = (typeof QUALITY_CHECK_IDS)[number];

export const ISSUE_TRACKERS = ["github", "linear", "either", "off"] as const;
export type IssueTracker = (typeof ISSUE_TRACKERS)[number];

export const CHECK_CATALOG: Record<CatalogId, { name: string; group: CheckPackGroup; kind: "machine" | "quality" }> = {
  "max-files-changed": { name: "Max files changed", group: "pull-request", kind: "machine" },
  "max-lines-changed": { name: "Max lines changed", group: "pull-request", kind: "machine" },
  focused: { name: "Focused", group: "pull-request", kind: "quality" },
  docs: { name: "Docs", group: "pull-request", kind: "quality" },
  "linked-issue": { name: "Linked issue", group: "issue", kind: "machine" },
  "no-merge-conflicts": { name: "No merge conflicts", group: "around", kind: "machine" },
  "ci-green": { name: "CI green", group: "code-vs-ci", kind: "machine" },
  "no-forbidden-paths": { name: "No forbidden paths", group: "code-vs-ci", kind: "machine" },
};

export const NOT_A_DRAFT = "not-a-draft";
export const NO_CHANGES_REQUESTED = "no-changes-requested";

/** Rules pr-triage runs on every pull request, outside any policy's switches. */
export const BUILT_IN_CHECK_NAMES: ReadonlyMap<string, string> = new Map([[NOT_A_DRAFT, "Not a draft"], [NO_CHANGES_REQUESTED, "No changes requested"]]);

export function isCatalogId(id: string): id is CatalogId {
  return (CATALOG_IDS as readonly string[]).includes(id);
}

export function checkName(pack: CheckPack, id: string): string {
  const builtIn = BUILT_IN_CHECK_NAMES.get(id);
  if (builtIn !== undefined) return builtIn;
  return isCatalogId(id) ? CHECK_CATALOG[id].name : pack.custom.find((row) => row.id === id)?.name ?? id;
}

/** Built-in rules since removed; stored policies and verdicts may still name them. */
export const RETIRED_CHECK_IDS: ReadonlySet<string> = new Set(["duplicate", "reviewers", "drift", "tests"]);

/** Built-in rule ids before they were renamed, to the rules that replaced them; stored policies and verdicts may still name them. */
export const RENAMED_RULE_IDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["size", ["max-files-changed", "max-lines-changed"]],
  ["issue", ["linked-issue"]],
  ["conflicts", ["no-merge-conflicts"]],
  ["ci", ["ci-green"]],
  ["paths", ["no-forbidden-paths"]],
  ["draft", [NOT_A_DRAFT]],
  ["review", [NO_CHANGES_REQUESTED]],
]);

/** The current ids of a rule id as stored, which may predate a rename. */
export function currentRuleIds(id: string): readonly string[] {
  return RENAMED_RULE_IDS.get(id) ?? [id];
}

const SIZE_LIMITS: Array<[string, RegExp]> = [["max-files-changed", /^\d+ files \(max /], ["max-lines-changed", /^\d+ lines changed \(max /]];

/** A recorded verdict row under the current ids. An old size row splits into the limits its evidence names; one without evidence stands for both. */
export function currentRows(check: string, evidence: readonly string[] = []): Array<{ check: string; evidence: string[] }> {
  if (check === "size") {
    const split = SIZE_LIMITS.flatMap(([id, pattern]) => {
      const lines = evidence.filter((line) => pattern.test(line));
      return lines.length ? [{ check: id, evidence: lines }] : [];
    });
    if (split.length) return split;
  }
  return currentRuleIds(check).map((id) => ({ check: id, evidence: [...evidence] }));
}

/** The finding a closed pull request gets; a verdict id, never a rule's. */
export const CLOSED_FINDING = "state";

export const RECOMMENDED_SIZE = { maxFiles: 30, maxLines: 3000 } as const;
export const RECOMMENDED_PATHS = { forbiddenGlobs: ["vendor/**", "node_modules/**"] } as const;
export const RECOMMENDED_ISSUE = { tracker: "either" } as const;

export type CatalogCheck = {
  enabled: boolean;
  maxFiles?: number;
  maxLines?: number;
  tracker?: IssueTracker;
  forbiddenGlobs?: string[];
};

export const RULE_KINDS = [
  "paths-unchanged",
  "paths-together",
  "title-pattern",
  "branch-pattern",
  "label-required",
  "diff-excludes",
  "min-approvals",
  "author",
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const MODEL_SHAPES = ["is-true", "score", "choose"] as const;
export type ModelShape = (typeof MODEL_SHAPES)[number];

/** What an is-true check asks about: the whole pull request, or each changed file or hunk under its `when` globs. */
export const CUSTOM_SCOPES = ["pull-request", "file", "hunk"] as const;
export type CustomScope = (typeof CUSTOM_SCOPES)[number];

export const AUTHOR_KINDS = ["owner", "member", "collaborator", "contributor", "first-timer", "outside", "bot"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];
export const AUTHOR_WHO = ["users", "role", "kinds"] as const;
export type AuthorWho = (typeof AUTHOR_WHO)[number];

/** GitHub's author association folded to the kinds a pack names; a bot is a bot whatever its association, and no association is unknown. */
export function authorKindOf(association: AuthorAssociation | null, bot: boolean): AuthorKind | undefined {
  if (bot) return "bot";
  switch (association) {
    case "OWNER": return "owner";
    case "MEMBER": return "member";
    case "COLLABORATOR": return "collaborator";
    case "CONTRIBUTOR": return "contributor";
    case "FIRST_TIME_CONTRIBUTOR":
    case "FIRST_TIMER": return "first-timer";
    case "NONE":
    case "MANNEQUIN": return "outside";
    case null: return undefined;
  }
}

/** Patterns are regular expressions without flags; globs use `*` within a path segment and `**` across segments. */
type RuleParams = {
  "paths-unchanged": { globs: string[] };
  "paths-together": { changed: string[]; requires: string[] };
  "title-pattern": { pattern: string };
  "branch-pattern": { pattern: string };
  "label-required": { label: string };
  "diff-excludes": { pattern: string };
  "min-approvals": { count: number };
  author: { who: "users"; users: string[] } | { who: "role"; role: string } | { who: "kinds"; kinds: AuthorKind[] };
};
export type RuleCheck = { [K in RuleKind]: { rule: K } & RuleParams[K] }[RuleKind];

/**
 * `score` passes at `min` or above on a 0 to 10 scale; `choose` fails when the answer is one of `failOn`. A file or hunk
 * scoped `is-true` asks whether each item in scope meets `claim`, and applies only to paths matching `when` when it is set.
 */
type ModelParams = {
  "is-true": { claim: string; scope?: CustomScope; when?: string[] };
  score: { subject: string; min: number };
  choose: { options: string[]; failOn: string[] };
};
export type ModelCheck = { [K in ModelShape]: { shape: K } & ModelParams[K] }[ModelShape];

/** `enabled` is stored only as false; an absent flag means the check runs. */
export type CustomCheck = { id: string; name: string; group: CheckPackGroup; enabled?: boolean } & (
  | ({ kind: "rule" } & RuleCheck)
  | ({ kind: "model" } & ModelCheck)
);
export type ModelCustomCheck = Extract<CustomCheck, { kind: "model" }>;
export type RuleCustomCheck = Extract<CustomCheck, { kind: "rule" }>;

const SCORE_MAX = 10;
const PATTERN_MAX = 200;
const GLOB_MAX = 200;
const GLOBS_MAX = 50;
const CUSTOM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CUSTOM_ID_MAX = 64;

export const ACTION_KINDS = ["labels", "assign", "request-review", "comment", "approve", "request-changes", "close", "agent"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Do kinds since removed; stored packs may still name them. */
const RETIRED_DO_KINDS: ReadonlySet<unknown> = new Set(["convert-to-draft"]);

export const TRIAGE_EVENTS = [
  "opened",
  "updated",
  "ready",
  "drafted",
  "commented",
  "reviewed",
  "approved",
  "changes-requested",
  "checks",
  "closed",
  "merged",
  "catch-up",
] as const;
export type TriageEvent = (typeof TRIAGE_EVENTS)[number];

const COMMENT_BODY_MAX = 65536;

/** A built-in rule, the not-a-draft rule or a custom rule's id. */
export type CheckRef = string;

/** The events a policy's actions wake on; a catch-up run wakes them whatever its policy names. */
export const POLICY_EVENTS = ["opened", "updated", "checks", "ready"] as const satisfies readonly TriageEvent[];
export type PolicyEvent = (typeof POLICY_EVENTS)[number];

/** What triage decides about each pull request head; each names the action list that runs on it. */
export const VERDICTS = ["pass", "fail", "unsure"] as const;
export type VerdictWord = (typeof VERDICTS)[number];

export type LabelsTarget = { from: "list"; labels: string[] } | { from: "type" } | { from: "paths" };
/** A role names an entry in the repository settings' roles, resolved at evaluation time. */
export type PeopleTarget =
  | { to: "users"; users: string[] }
  | { to: "teams"; teams: string[] }
  | { to: "role"; role: string }
  | { to: "codeowners" }
  | { to: "author" };
export type ReviewTarget = Exclude<PeopleTarget, { to: "author" }>;
export type CommentTarget = { body: string };
export type CloseTarget = Record<string, never>;
export type AgentTarget = { prompt: string; tools: string[] };

export type Do =
  | { kind: "labels"; target: LabelsTarget }
  | { kind: "assign"; target: PeopleTarget }
  | { kind: "request-review"; target: ReviewTarget }
  | { kind: "comment"; target: CommentTarget }
  | { kind: "approve"; target: CloseTarget }
  | { kind: "request-changes"; target: CloseTarget }
  | { kind: "close"; target: CloseTarget }
  | { kind: "agent"; target: AgentTarget };

/** One list of Dos per verdict, run when an event in `when` wakes the policy. */
export type PolicyActions = { when: PolicyEvent[] } & Record<VerdictWord, Do[]>;

export type CheckPack = {
  kind: typeof CHECK_PACK_KIND;
  schemaVersion: typeof CHECK_PACK_SCHEMA_VERSION;
  repo: string;
  checks: Partial<Record<CatalogId, CatalogCheck>>;
  custom: CustomCheck[];
  actions: PolicyActions;
};

/** A new pack's policy wakes on every event and asks a person to review what it is unsure of. */
export function defaultActions(): PolicyActions {
  return { when: [...POLICY_EVENTS], pass: [], fail: [], unsure: [{ kind: "request-review", target: { to: "codeowners" } }] };
}

const Text = type(/\S/);
const Texts = Text.array().atLeastLength(1);
const RepoName = type(/^\s*(?!.*\.\.)(?!\.\/)[^\s\\/]+\/(?!\.\s*$)[^\s\\/]+\s*$/);

const ReviewTargetSchema = type({ "+": "reject", to: "'users'", users: Texts })
  .or({ "+": "reject", to: "'teams'", teams: Texts })
  .or({ "+": "reject", to: "'role'", role: Text })
  .or({ "+": "reject", to: "'codeowners'" });

const DoSchema = type({
  kind: "'labels'",
  target: type({ "+": "reject", from: "'list'", labels: Texts }).or({ "+": "reject", from: "'type' | 'paths'" }),
})
  .or({ kind: "'assign'", target: ReviewTargetSchema.or({ "+": "reject", to: "'author'" }) })
  .or({ kind: "'request-review'", target: ReviewTargetSchema })
  .or({ kind: "'comment'", target: { "+": "reject", body: Text } })
  .or({ kind: "'approve' | 'request-changes' | 'close'", target: { "+": "reject" } })
  .or({ kind: "'agent'", target: { "+": "reject", prompt: Text, tools: Text.array() } });

const DoList = DoSchema.array();

/** Packs written before verdicts held one list of actions, each choosing a branch from its own checks; reading one collapses them. */
const PolicyActionsSchema = type({
  "+": "reject",
  when: type.enumerated(...POLICY_EVENTS).array().atLeastLength(1),
  pass: DoList,
  fail: DoList,
  unsure: DoList,
}).or("object[]");

const CatalogCheckSchema = type({
  enabled: "boolean",
  "maxFiles?": "number",
  "maxLines?": "number",
  "tracker?": type.enumerated(...ISSUE_TRACKERS),
  "forbiddenGlobs?": "string[]",
});

const CUSTOM_BASE = { id: type(CUSTOM_ID).atMostLength(CUSTOM_ID_MAX), name: Text, group: type.enumerated(...CHECK_PACK_GROUPS), "enabled?": "boolean" } as const;
const RULE = { ...CUSTOM_BASE, kind: "'rule'" } as const;
const MODEL = { ...CUSTOM_BASE, kind: "'model'" } as const;

const CustomCheckSchema = type({ ...RULE, rule: "'paths-unchanged'", globs: Texts })
  .or({ ...RULE, rule: "'paths-together'", changed: Texts, requires: Texts })
  .or({ ...RULE, rule: "'title-pattern' | 'branch-pattern' | 'diff-excludes'", pattern: Text.atMostLength(PATTERN_MAX) })
  .or({ ...RULE, rule: "'label-required'", label: Text })
  .or({ ...RULE, rule: "'min-approvals'", count: "number.integer >= 1" })
  .or({ ...RULE, rule: "'author'", who: "'users'", users: Texts })
  .or({ ...RULE, rule: "'author'", who: "'role'", role: Text })
  .or({ ...RULE, rule: "'author'", who: "'kinds'", kinds: type.enumerated(...AUTHOR_KINDS).array().atLeastLength(1) })
  .or({ ...MODEL, shape: "'is-true'", claim: Text, "scope?": type.enumerated(...CUSTOM_SCOPES), "when?": Texts })
  .or({ ...MODEL, shape: "'score'", subject: Text, min: `0 <= number.integer <= ${SCORE_MAX}` })
  .or({ ...MODEL, shape: "'choose'", options: Text.array().atLeastLength(2), failOn: Texts });

const CatalogChecksSchema = type(
  Object.fromEntries(CATALOG_IDS.map((id) => [`${id}?`, CatalogCheckSchema])) as Record<`${CatalogId}?`, typeof CatalogCheckSchema>,
);

/**
 * Published as JSON Schema. `readCheckPack` stays the authority: it also drops catalog and blank legacy custom rows,
 * checks patterns and choices, and collapses legacy actions.
 */
export const checkPackSchema = type({
  kind: type.unit(CHECK_PACK_KIND),
  schemaVersion: type.unit(CHECK_PACK_SCHEMA_VERSION),
  repo: RepoName,
  "checks?": CatalogChecksSchema,
  "custom?": CustomCheckSchema.array().atMostLength(CUSTOM_CHECK_CAP),
  "actions?": PolicyActionsSchema,
});

const CATALOG_SET = new Set<string>(CATALOG_IDS);
const RESERVED_IDS = new Set<string>([...CATALOG_IDS, ...BUILT_IN_CHECK_NAMES.keys(), ...RENAMED_RULE_IDS.keys(), ...RETIRED_CHECK_IDS, "all", "verdict", CLOSED_FINDING]);
// Judge question ids are built from rule ids (`docs-file-001`, `focused-slice-001`, `<id>-hunk-001-002`), so no custom id may read as one.
const QUESTION_LIKE = /^(?:docs|focused)-|-(?:file|hunk|slice)(?:-\d+)+$/;

function customIdProblem(id: string): string | undefined {
  if (!CUSTOM_ID.test(id) || id.length > CUSTOM_ID_MAX) return `must be at most ${CUSTOM_ID_MAX} lowercase letters, digits and single hyphens`;
  if (RESERVED_IDS.has(id)) return "must not be a built-in rule's id";
  if (QUESTION_LIKE.test(id)) return "must not start with docs- or focused- or end in -file, -hunk or -slice and numbers";
  return undefined;
}

/**
 * A custom rule's id from its name: lowercase words joined by hyphens. A taken name is numbered past the highest
 * number its ids already carry, so the id of a removed rule is not handed to another while a later one remains.
 */
export function customRuleId(name: string, taken: Iterable<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, CUSTOM_ID_MAX - 12).replace(/^-+|-+$/g, "") || "rule";
  if (/^(?:docs|focused)-/.test(`${base}-`)) base = `rule-${base}`;
  if (QUESTION_LIKE.test(`${base}-2`)) base = `${base}-rule`;
  const ids = [...taken];
  const numbered = new RegExp(`^${base}-(\\d+)$`);
  const highest = Math.max(0, ...ids.flatMap((id) => numbered.exec(id)?.[1] ?? []).map(Number));
  if (highest === 0 && !ids.includes(base) && !RESERVED_IDS.has(base)) return base;
  return `${base}-${Math.max(highest, 1) + 1}`;
}

const GROUP_SET = new Set<string>(CHECK_PACK_GROUPS);
const TRACKER_SET = new Set<string>(ISSUE_TRACKERS);

export const CHECK_PACK_TITLE_PREFIX = "check-pack/";

export function checkPackName(repo: string): string {
  const clean = asRepo(repo);
  if (!clean) throw new Error("Repository must be owner/name.");
  return `${CHECK_PACK_TITLE_PREFIX}${clean}`;
}

export function emptyPack(repo: string): CheckPack {
  const clean = asRepo(repo);
  if (!clean) throw new Error("Repository must be owner/name.");
  return {
    kind: CHECK_PACK_KIND,
    schemaVersion: CHECK_PACK_SCHEMA_VERSION,
    repo: clean,
    checks: {},
    custom: [],
    actions: defaultActions(),
  };
}

export function recommendedPack(repo: string): CheckPack {
  const base = emptyPack(repo);
  return {
    ...base,
    checks: {
      "max-files-changed": { enabled: true, maxFiles: RECOMMENDED_SIZE.maxFiles },
      "max-lines-changed": { enabled: true, maxLines: RECOMMENDED_SIZE.maxLines },
      focused: { enabled: true },
      docs: { enabled: true },
      "linked-issue": { enabled: true, tracker: RECOMMENDED_ISSUE.tracker },
      "no-merge-conflicts": { enabled: true },
      "ci-green": { enabled: true },
      "no-forbidden-paths": { enabled: true, forbiddenGlobs: [...RECOMMENDED_PATHS.forbiddenGlobs] },
    },
    actions: { ...defaultActions(), pass: [{ kind: "approve", target: {} }] },
  };
}

export function applyRecommended(pack: CheckPack): CheckPack {
  return { ...pack, checks: recommendedPack(pack.repo).checks };
}

export function catalogCheckEnabled(pack: CheckPack, id: CatalogId): boolean {
  const row = pack.checks[id];
  return row !== undefined && row.enabled !== false;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function capGlobs(globs: string[], where: string): string[] {
  if (globs.length > GLOBS_MAX) throw new Error(`${where} must list at most ${GLOBS_MAX} globs.`);
  if (globs.some((glob) => glob.length > GLOB_MAX)) throw new Error(`${where} must be globs of at most ${GLOB_MAX} characters.`);
  return globs;
}

function globs(value: unknown, where: string): string[] {
  return capGlobs(texts(value, where), where);
}

function parseGlobs(value: unknown, where: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return capGlobs(value.flatMap((item) => (typeof item === "string" && item.trim().length > 0 ? [item.trim()] : [])), where);
}

function parseCatalogCheck(id: CatalogId, raw: unknown): CatalogCheck | undefined {
  const row = asRecord(raw);
  if (!row) return undefined;
  const check: CatalogCheck = { enabled: row.enabled === false ? false : true };
  if (id === "max-files-changed") {
    const maxFiles = finiteNumber(row.maxFiles);
    if (maxFiles !== undefined) check.maxFiles = maxFiles;
  }
  if (id === "max-lines-changed") {
    const maxLines = finiteNumber(row.maxLines);
    if (maxLines !== undefined) check.maxLines = maxLines;
  }
  if (id === "linked-issue") {
    if (typeof row.tracker === "string" && TRACKER_SET.has(row.tracker)) check.tracker = row.tracker as IssueTracker;
  }
  if (id === "no-forbidden-paths") {
    const globs = parseGlobs(row.forbiddenGlobs, "No forbidden paths globs");
    if (globs) check.forbiddenGlobs = globs;
  }
  return check;
}

/** An old size row that set only one limit never measured the other, so that half loads switched off. */
function sizeLimitMissing(id: string, raw: unknown): boolean {
  const row = asRecord(raw);
  const files = finiteNumber(row?.maxFiles) !== undefined;
  const lines = finiteNumber(row?.maxLines) !== undefined;
  return files !== lines && (id === "max-files-changed" ? !files : !lines);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${where} must be one of ${allowed.join(", ")}.`);
}

function verbatim(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${where} must be a non-empty string.`);
  return value;
}

function text(value: unknown, where: string): string {
  return verbatim(value, where).trim();
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${where} must be a non-empty list.`);
  return value;
}

function texts(value: unknown, where: string): string[] {
  const out = new Set<string>();
  for (const item of list(value, where)) out.add(text(item, where));
  return [...out];
}

function record(value: unknown, where: string): Record<string, unknown> {
  const row = asRecord(value);
  if (!row) throw new Error(`${where} must be an object.`);
  return row;
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[], where: string): void {
  const keys = Object.keys(row).filter((key) => row[key] !== undefined);
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    throw new Error(`${where} must set exactly ${expected.join(", ") || "nothing"}.`);
  }
}

function pattern(value: unknown, where: string): string {
  const source = verbatim(value, where);
  if (source.length > PATTERN_MAX) throw new Error(`${where} must be at most ${PATTERN_MAX} characters.`);
  try {
    RE2JS.compile(source);
  } catch (error) {
    if (!(error instanceof RE2JSSyntaxException)) throw error;
    throw new Error(`${where} must be a valid regular expression without lookaround or backreferences: ${error.message}.`);
  }
  return source;
}

function distinctTexts(value: unknown, where: string): string[] {
  const out = list(value, where).map((item) => text(item, where));
  if (new Set(out).size !== out.length) throw new Error(`${where} must not repeat a value.`);
  return out;
}

function integer(value: unknown, min: number, max: number, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${where} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function parseRule(row: Record<string, unknown>, where: string): RuleCheck {
  const rule = oneOf(row.rule, RULE_KINDS, `${where} rule`);
  switch (rule) {
    case "paths-unchanged":
      return { rule, globs: globs(row.globs, `${where} globs`) };
    case "paths-together":
      return { rule, changed: globs(row.changed, `${where} changed`), requires: globs(row.requires, `${where} requires`) };
    case "title-pattern":
    case "branch-pattern":
    case "diff-excludes":
      return { rule, pattern: pattern(row.pattern, `${where} pattern`) };
    case "label-required":
      return { rule, label: verbatim(row.label, `${where} label`) };
    case "min-approvals":
      return { rule, count: integer(row.count, 1, Number.MAX_SAFE_INTEGER, `${where} count`) };
    case "author": {
      const who = oneOf(row.who, AUTHOR_WHO, `${where} who`);
      if (who === "users") return { rule, who, users: texts(row.users, `${where} users`).map((login) => login.replace(/^@/, "")) };
      if (who === "role") return { rule, who, role: text(row.role, `${where} role`) };
      return { rule, who, kinds: [...new Set(texts(row.kinds, `${where} kinds`).map((kind) => oneOf(kind, AUTHOR_KINDS, `${where} kinds`)))] };
    }
  }
}

function parseScope(row: Record<string, unknown>, where: string): { scope?: CustomScope; when?: string[] } {
  const scope = row.scope === undefined ? undefined : oneOf(row.scope, CUSTOM_SCOPES, `${where} scope`);
  if (row.when === undefined) return scope === undefined ? {} : { scope };
  if (scope === undefined || scope === "pull-request") throw new Error(`${where} when needs a file or hunk scope.`);
  return { scope, when: globs(row.when, `${where} when`) };
}

function parseModel(row: Record<string, unknown>, where: string): ModelCheck {
  const shape = oneOf(row.shape, MODEL_SHAPES, `${where} shape`);
  if (shape !== "is-true" && (row.scope !== undefined || row.when !== undefined)) throw new Error(`${where} scope and when apply only to is-true checks.`);
  switch (shape) {
    case "is-true":
      return { shape, claim: text(row.claim, `${where} claim`), ...parseScope(row, where) };
    case "score":
      return { shape, subject: text(row.subject, `${where} subject`), min: integer(row.min, 0, SCORE_MAX, `${where} min`) };
    case "choose": {
      const options = distinctTexts(row.options, `${where} options`);
      if (options.length < 2) throw new Error(`${where} options must list at least two choices.`);
      const failOn = distinctTexts(row.failOn, `${where} failOn`);
      if (failOn.some((option) => !options.includes(option))) throw new Error(`${where} failOn must be among options.`);
      return { shape, options, failOn };
    }
  }
}

function parseTypedCustom(row: Record<string, unknown>, index: number): CustomCheck {
  const where = `Custom rule ${typeof row.id === "string" ? row.id : index + 1}`;
  if (typeof row.id !== "string") throw new Error(`${where} id must be a string.`);
  const problem = customIdProblem(row.id);
  if (problem) throw new Error(`${where} id ${problem}.`);
  if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw new Error(`${where} enabled must be true or false.`);
  const base = { id: row.id, name: text(row.name, `${where} name`), group: oneOf(row.group, CHECK_PACK_GROUPS, `${where} group`), ...(row.enabled === false && { enabled: false }) };
  const kind = oneOf(row.kind, ["rule", "model"] as const, `${where} kind`);
  return kind === "rule" ? { ...base, kind, ...parseRule(row, where) } : { ...base, kind, ...parseModel(row, where) };
}

/** A legacy row has no kind; it asks its instruction as an is-true question and is dropped when blank. */
function parseLegacyCustom(row: Record<string, unknown>, next: number): CustomCheck | undefined {
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const instruction = typeof row.instruction === "string" ? row.instruction.trim() : "";
  const group = typeof row.group === "string" ? row.group.trim() : "";
  if (!name || !instruction || !GROUP_SET.has(group)) return undefined;
  const requested = typeof row.id === "string" ? row.id.trim() : "";
  const id = customIdProblem(requested) === undefined ? requested : `custom-${next}`;
  return { id, name, group: group as CheckPackGroup, kind: "model", shape: "is-true", claim: instruction };
}

function parseCustom(raw: unknown): CustomCheck[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, CustomCheck>();
  let next = 1;
  for (const [index, item] of raw.entries()) {
    const row = asRecord(item);
    if (!row) continue;
    const check = row.kind === undefined ? parseLegacyCustom(row, next) : parseTypedCustom(row, index);
    if (!check) continue;
    const n = check.id.startsWith("custom-") ? Number(check.id.slice("custom-".length)) : Number.NaN;
    if (Number.isInteger(n) && n >= next) next = n + 1;
    else next += 1;
    if (!byId.has(check.id) && byId.size >= CUSTOM_CHECK_CAP) {
      throw new Error(`Policy must have at most ${CUSTOM_CHECK_CAP} custom rules.`);
    }
    byId.set(check.id, check);
  }
  return [...byId.values()];
}

function parseLabelsTarget(target: Record<string, unknown>, where: string): LabelsTarget {
  const from = oneOf(target.from, ["list", "type", "paths"] as const, `${where} from`);
  if (from !== "list") {
    exactKeys(target, ["from"], where);
    return { from };
  }
  exactKeys(target, ["from", "labels"], where);
  return { from, labels: texts(target.labels, `${where} labels`) };
}

function parsePeopleTarget(target: Record<string, unknown>, allowAuthor: boolean, where: string): PeopleTarget {
  const kinds = allowAuthor
    ? (["users", "teams", "role", "codeowners", "author"] as const)
    : (["users", "teams", "role", "codeowners"] as const);
  const to = oneOf(target.to, kinds, `${where} to`);
  if (to === "codeowners" || to === "author") {
    exactKeys(target, ["to"], where);
    return { to };
  }
  exactKeys(target, ["to", to], where);
  if (to === "role") return { to, role: text(target.role, `${where} role`) };
  if (to === "users") return { to, users: texts(target.users, `${where} users`) };
  return { to, teams: texts(target.teams, `${where} teams`) };
}

function parseDo(raw: unknown, where: string): Do {
  const row = record(raw, where);
  const kind = oneOf(row.kind, ACTION_KINDS, `${where} kind`);
  const at = `${where} target`;
  const target = record(row.target, at);
  switch (kind) {
    case "labels":
      return { kind, target: parseLabelsTarget(target, at) };
    case "assign":
      return { kind, target: parsePeopleTarget(target, true, at) };
    case "request-review":
      return { kind, target: parsePeopleTarget(target, false, at) as ReviewTarget };
    case "comment": {
      exactKeys(target, ["body"], at);
      const body = text(target.body, `${at} body`);
      if (body.length > COMMENT_BODY_MAX) throw new Error(`${at} body must be at most ${COMMENT_BODY_MAX} characters.`);
      return { kind, target: { body } };
    }
    case "approve":
    case "request-changes":
    case "close":
      exactKeys(target, [], at);
      return { kind, target: {} };
    case "agent": {
      exactKeys(target, ["prompt", "tools"], at);
      if (!Array.isArray(target.tools)) throw new Error(`${at} tools must be a list.`);
      const tools = new Set<string>();
      for (const tool of target.tools) tools.add(text(tool, `${at} tools`));
      return { kind, target: { prompt: text(target.prompt, `${at} prompt`), tools: [...tools] } };
    }
  }
}

function parseList(raw: unknown, where: string): Do[] {
  if (!Array.isArray(raw)) throw new Error(`${where} must be a list.`);
  return raw.flatMap((item, i) => (RETIRED_DO_KINDS.has(record(item, `${where} ${i + 1}`).kind) ? [] : [parseDo(item, `${where} ${i + 1}`)]));
}

function parseWhen(raw: unknown, where: string): PolicyEvent[] {
  const events = new Set<PolicyEvent>();
  for (const event of list(raw, where)) events.add(oneOf(event, POLICY_EVENTS, where));
  return POLICY_EVENTS.filter((event) => events.has(event));
}

/** The same Do listed twice runs once. */
function distinctDos(dos: Do[]): Do[] {
  const seen = new Set<string>();
  return dos.filter(function first(step) {
    const key = JSON.stringify(step);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const LEGACY_LISTS: Record<string, VerdictWord[]> = { yes: ["pass"], no: ["fail"], unsure: ["unsure"], always: ["pass", "fail", "unsure"] };

/** Which lists a legacy Do joins: one that ran without checks joins all three, except a close or agent, which only ever ran with a person's approval and stays held on Unsure. */
function listsOf(branch: string, step: Do): VerdictWord[] {
  return branch === "always" && (step.kind === "close" || step.kind === "agent") ? ["unsure"] : LEGACY_LISTS[branch]!;
}

/**
 * Legacy actions collapse into one policy: each branch's Dos join its verdict's list, `always` joins all three, and
 * `when` is every action's together. An action that woke on no event a policy names is dropped, not widened.
 */
function migrateActions(rows: unknown[]): PolicyActions {
  const when = new Set<PolicyEvent>();
  const lists: Record<VerdictWord, Do[]> = { pass: [], fail: [], unsure: [] };
  for (const [index, raw] of rows.entries()) {
    const row = record(raw, `Action ${index + 1}`);
    const where = `Action ${typeof row.id === "string" ? row.id : index + 1}`;
    const named = row.when === "every" ? POLICY_EVENTS : Array.isArray(row.when) ? row.when : [];
    const events = POLICY_EVENTS.filter((event) => named.includes(event));
    if (events.length === 0) continue;
    for (const event of events) when.add(event);
    for (const [branch, dos] of Object.entries(record(row.branches, `${where} branches`))) {
      if (!LEGACY_LISTS[branch]) throw new Error(`${where} branches must set only yes, no, unsure or always.`);
      for (const step of parseList(dos, `${where} ${branch}`)) for (const verdict of listsOf(branch, step)) lists[verdict].push(step);
    }
  }
  return {
    when: when.size > 0 ? POLICY_EVENTS.filter((event) => when.has(event)) : [...POLICY_EVENTS],
    pass: distinctDos(lists.pass),
    fail: distinctDos(lists.fail),
    unsure: distinctDos(lists.unsure),
  };
}

function parseActions(raw: unknown): PolicyActions {
  if (raw === undefined) return { when: [...POLICY_EVENTS], pass: [], fail: [], unsure: [] };
  if (Array.isArray(raw)) return migrateActions(raw);
  const row = record(raw, "Actions");
  exactKeys(row, ["when", ...VERDICTS], "Actions");
  return {
    when: parseWhen(row.when, "Actions when"),
    pass: distinctDos(parseList(row.pass, "Actions pass")),
    fail: distinctDos(parseList(row.fail, "Actions fail")),
    unsure: distinctDos(parseList(row.unsure, "Actions unsure")),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Policy must be JSON.");
  }
}

/** Reads a stored pack, throwing an Error whose message says why it is rejected. */
export function readCheckPack(raw: unknown, expectedRepo?: string): CheckPack {
  const body = asRecord(parseJson(raw));
  if (!body) throw new Error("Policy must be an object.");
  if (body.kind !== CHECK_PACK_KIND) throw new Error(`kind must be ${CHECK_PACK_KIND}.`);
  if (body.schemaVersion !== CHECK_PACK_SCHEMA_VERSION) throw new Error(`schemaVersion must be ${CHECK_PACK_SCHEMA_VERSION}.`);
  const repo = asRepo(body.repo);
  if (!repo) throw new Error("repo must be owner/name.");
  if (expectedRepo !== undefined && asRepo(expectedRepo) !== repo) throw new Error(`repo must be ${expectedRepo}.`);
  const checksRaw = body.checks === undefined ? {} : asRecord(body.checks);
  if (!checksRaw) throw new Error("checks must be an object.");
  const checks: CheckPack["checks"] = {};
  // A row under its current id wins over one stored under the id it had before a rename.
  for (const [stored, value] of Object.entries(checksRaw)) {
    for (const id of currentRuleIds(stored)) {
      if (!CATALOG_SET.has(id) || (stored !== id && checks[id as CatalogId])) continue;
      const parsed = parseCatalogCheck(id as CatalogId, value);
      if (parsed && stored === "size" && sizeLimitMissing(id, value)) parsed.enabled = false;
      if (parsed) checks[id as CatalogId] = parsed;
    }
  }
  return {
    kind: CHECK_PACK_KIND,
    schemaVersion: CHECK_PACK_SCHEMA_VERSION,
    repo,
    checks,
    custom: parseCustom(body.custom),
    actions: parseActions(body.actions),
  };
}

export function parseCheckPack(raw: unknown, expectedRepo?: string): CheckPack | null {
  try {
    return readCheckPack(raw, expectedRepo);
  } catch {
    return null;
  }
}

export function customCheckEnabled(row: CustomCheck): boolean {
  return row.enabled !== false;
}

function isModelCheck(row: CustomCheck): row is ModelCustomCheck {
  return row.kind === "model";
}

function isRuleCheck(row: CustomCheck): row is RuleCustomCheck {
  return row.kind === "rule";
}

/** Switched-off custom rows are left out. Model rows are handed to the classifier as plain text; rule rows are evaluated from facts and listed here for naming. */
export function classificationSources(pack: CheckPack): {
  quality: Array<{ id: QualityCheckId; group: CheckPackGroup }>;
  custom: ModelCustomCheck[];
  rules: RuleCustomCheck[];
} {
  return {
    quality: QUALITY_CHECK_IDS.filter((id) => catalogCheckEnabled(pack, id)).map((id) => ({
      id,
      group: CHECK_CATALOG[id].group,
    })),
    custom: pack.custom.filter(customCheckEnabled).filter(isModelCheck),
    rules: pack.custom.filter(customCheckEnabled).filter(isRuleCheck),
  };
}
