import { type } from "arktype";
import { asRecord, asRepo } from "@corbits/common";
import { AUTHOR_ASSOCIATIONS, type AuthorAssociation } from "./repo-policy.js";

export const CHECK_PACK_KIND = "corbits.triage.check-pack";
/** Version 2 holds steps, model-only custom rules and verdict labels; version 1 is read only when it held no actions. */
export const CHECK_PACK_SCHEMA_VERSION = 2;
export const LEGACY_SCHEMA_VERSION = 1;
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

/** Outside any policy's switches. */
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

/** May predate a rename. */
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
// An author who edits `.github/**` can change which checks run and turn CI green.
export const RECOMMENDED_PATHS = { forbiddenGlobs: ["vendor/**", "node_modules/**", ".github/**"] } as const;
export const RECOMMENDED_ISSUE = { tracker: "either" } as const;
export const RECOMMENDED_TEXT: Readonly<TextCustomCheck> = {
  id: "no-attribution-trailers",
  name: "No attribution trailers",
  group: "pull-request",
  kind: "text",
  fields: ["description", "commits"],
  failWhen: "contains",
  phrases: ["Co-Authored-By:", "Generated with", "Claude-Session:"],
};

/**
 * Why a rule exists: its sentence (`text`, which a model rule keeps as its `claim`), a one-line `reason`, and `evidence`,
 * pull request references (`#44`, `owner/name#44`), links, or `maintainer-stated`. Policies written before rules carried
 * them have none.
 */
export type RuleNote = { text?: string; reason?: string; evidence?: string[] };

const MAINTAINER_STATED = "maintainer-stated";

export type CatalogCheck = RuleNote & {
  enabled: boolean;
  maxFiles?: number;
  maxLines?: number;
  tracker?: IssueTracker;
  forbiddenGlobs?: string[];
};

export const MODEL_SHAPES = ["is-true", "score", "choose"] as const;
export type ModelShape = (typeof MODEL_SHAPES)[number];

export const CUSTOM_SCOPES = ["pull-request", "file", "hunk"] as const;
export type CustomScope = (typeof CUSTOM_SCOPES)[number];

/** GitHub's author association, or `BOT` for a bot whatever its association. */
export const AUTHOR_KINDS = [...AUTHOR_ASSOCIATIONS, "BOT"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

/** No association is unknown. */
export function authorKindOf(association: AuthorAssociation | null, bot: boolean): AuthorKind | undefined {
  if (bot) return "BOT";
  return association ?? undefined;
}

/** Named sets of author kinds. Steps written before author kinds were GitHub's own name them, and each reads as exactly its kinds. */
export const AUTHOR_GROUPS = {
  "first-timers": ["FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"],
  maintainers: ["OWNER", "MEMBER", "COLLABORATOR"],
  external: ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "MANNEQUIN"],
  bots: ["BOT"],
} as const satisfies Record<string, readonly AuthorKind[]>;
export type AuthorGroup = keyof typeof AUTHOR_GROUPS;

function authorKinds(match: unknown): readonly unknown[] {
  return typeof match === "string" && Object.hasOwn(AUTHOR_GROUPS, match) ? AUTHOR_GROUPS[match as AuthorGroup] : [match];
}

function stepWithAuthorKinds(raw: unknown): unknown {
  const step = asRecord(raw);
  const when = asRecord(step?.when);
  if (!step || !Array.isArray(when?.author)) return raw;
  return { ...step, when: { ...when, author: when.author.flatMap(authorKinds) } };
}

/** A policy body for a schema that names only author kinds: any author group in its steps reads as the kinds it held. */
export function withAuthorKinds(raw: unknown): unknown {
  const body = asRecord(raw);
  const actions = asRecord(body?.actions);
  if (!body || !actions) return raw;
  const lists = VERDICTS.flatMap((verdict) => (Array.isArray(actions[verdict]) ? [[verdict, actions[verdict].map(stepWithAuthorKinds)]] : []));
  return { ...body, actions: { ...actions, ...Object.fromEntries(lists) } };
}

/**
 * `score` picks one of `levels`, ordered worst first, and fails only below `failBelow` when it is set; `choose` picks one
 * of `options` and fails when that is one of `failOn`. A file or hunk scoped `is-true` asks whether each item in scope
 * meets `claim`, and applies only to paths matching `when` when it is set; globs use `*` within a path segment and `**`
 * across segments.
 */
type ModelParams = {
  "is-true": { claim: string; scope?: CustomScope; when?: string[] };
  score: { subject: string; levels: string[]; failBelow?: string };
  choose: { options: string[]; failOn: string[] };
};
export type ModelCheck = { [K in ModelShape]: { shape: K } & ModelParams[K] }[ModelShape];

export const TEXT_FIELDS = ["title", "description", "commits"] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export const TEXT_MATCHES = ["contains", "not-contains"] as const;
export type TextMatch = (typeof TEXT_MATCHES)[number];

/**
 * Fails when any of `fields` (the title, the description, each commit message) contains any of `phrases`, or with
 * `not-contains` when one contains none of them; matched without regard to case.
 */
export type TextCheck = { fields: TextField[]; failWhen: TextMatch; phrases: string[] };

/**
 * A custom rule is asked of the decision model, or a text rule read from the pull request without it; `enabled` is
 * stored only as false, and an absent flag means it runs.
 */
type CustomBase = RuleNote & { id: string; name: string; group: CheckPackGroup; enabled?: boolean };
export type ModelCustomCheck = CustomBase & { kind: "model" } & ModelCheck;
export type TextCustomCheck = CustomBase & { kind: "text" } & TextCheck;
export type CustomCheck = ModelCustomCheck | TextCustomCheck;

const LEVELS_MIN = 2;
const LEVELS_MAX = 10;
export const DEFAULT_SCORE_LEVELS = ["poor", "fair", "good", "great"] as const;
const GLOB_MAX = 200;
const GLOBS_MAX = 50;
const CUSTOM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CUSTOM_ID_MAX = 64;

export const STEP_KINDS = ["approve", "merge", "close", "comment", "request-changes", "request-review", "assign", "labels", "nothing"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Each is granted on its own. */
export const ACTION_KINDS = ["labels", "assign", "request-review", "comment", "approve", "request-changes", "close", "merge"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type AuthorMatch = AuthorKind | { team: string } | { users: string[] };

export const CI_STATES = ["passing", "failing", "pending", "none"] as const;
export type CiState = (typeof CI_STATES)[number];

export type SizeBound = { over?: number; atMost?: number };

/**
 * What must all hold for a step to run, beside the verdict its list is for: the author is any of `author`, the pull
 * request does or does not link an issue, its CI is any of `ci`, and it changes more than `over` and at most `atMost`
 * files or lines.
 */
export type StepWhen = { author?: AuthorMatch[]; linkedIssue?: boolean; ci?: CiState[]; files?: SizeBound; lines?: SizeBound };

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
const LINE_MAX = 500;
// GitHub refuses a label name longer than this.
export const LABEL_MAX = 50;
const LIST_MAX = 50;
const STEPS_MAX = 20;

export type CheckRef = string;

/** The events a policy's actions wake on; a catch-up run wakes them whatever its policy names. */
export const POLICY_EVENTS = ["opened", "updated", "checks", "ready"] as const satisfies readonly TriageEvent[];
export type PolicyEvent = (typeof POLICY_EVENTS)[number];

export const VERDICTS = ["pass", "fail", "unsure"] as const;
export type VerdictWord = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Record<VerdictWord, string> = { pass: "Triage: Ready", fail: "Triage: Not Ready", unsure: "Triage: Needs Human Review" };

/** On a head held for its CI until the verdict replaces it. */
export const WAITING_LABEL = "Triage: Waiting for CI";

/** `rules` labels each failed rule (`ruleLabel`); the verdict's label is the policy's `labels`, which the mirror writes. */
export type LabelsTarget = { from: "list"; labels: string[] } | { from: "rules" };
export type PeopleTarget =
  | { to: "users"; users: string[] }
  | { to: "teams"; teams: string[] }
  | { to: "codeowners" }
  | { to: "author" };
export type ReviewTarget = Exclude<PeopleTarget, { to: "author" }>;
export type CommentTarget = { body: string };

export type Step = (
  | { do: "labels"; target: LabelsTarget }
  | { do: "assign"; target: PeopleTarget }
  | { do: "request-review"; target: ReviewTarget }
  | { do: "comment"; target: CommentTarget }
  | { do: "approve" }
  | { do: "merge" }
  | { do: "close" }
  | { do: "request-changes" }
  | { do: "nothing" }
) & { when?: StepWhen };

export type PolicyActions = { when: PolicyEvent[] } & Record<VerdictWord, Step[]>;

export type CheckPack = {
  kind: typeof CHECK_PACK_KIND;
  schemaVersion: typeof CHECK_PACK_SCHEMA_VERSION;
  repo: string;
  checks: Partial<Record<CatalogId, CatalogCheck>>;
  custom: CustomCheck[];
  actions: PolicyActions;
  /** So tools watching GitHub can react to it. */
  labels: Record<VerdictWord, string>;
  /** What reading the stored policy left out because it no longer runs; each verdict says so. Never read back. */
  dropped?: string[];
};

/** A new pack's policy wakes on every event and asks a person to review what it is unsure of. */
export function defaultActions(): PolicyActions {
  return { when: [...POLICY_EVENTS], pass: [], fail: [], unsure: [{ do: "request-review", target: { to: "codeowners" } }] };
}

export const Text = type(/\S/).atMostLength(LINE_MAX);
export const Label = type(/\S/).atMostLength(LABEL_MAX);
const Texts = Text.array().atLeastLength(1).atMostLength(LIST_MAX);
const RepoName = type(/^\s*(?!.*\.\.)(?!\.\/)[^\s\\/]+\/(?!\.\s*$)[^\s\\/]+\s*$/);

const ReviewTargetSchema = type({ "+": "reject", to: "'users'", users: Texts })
  .or({ "+": "reject", to: "'teams'", teams: Texts })
  .or({ "+": "reject", to: "'codeowners'" });

const AuthorMatchSchema = type.enumerated(...AUTHOR_KINDS).or({ "+": "reject", team: Text }).or({ "+": "reject", users: Texts });
const Count = type("number.integer").atLeast(0);
const SizeBoundSchema = type({ "+": "reject", "over?": Count, "atMost?": Count });
const stepWhenSchema = type({
  "+": "reject",
  "author?": AuthorMatchSchema.array().atLeastLength(1).atMostLength(LIST_MAX),
  "linkedIssue?": "boolean",
  "ci?": type.enumerated(...CI_STATES).array().atLeastLength(1),
  "files?": SizeBoundSchema,
  "lines?": SizeBoundSchema,
});
const STEP_BASE = { "+": "reject", "when?": stepWhenSchema } as const;

const StepSchema = type({
  ...STEP_BASE,
  do: "'labels'",
  target: type({ "+": "reject", from: "'list'", labels: Label.array().atLeastLength(1).atMostLength(LIST_MAX) }).or({ "+": "reject", from: "'rules'" }),
})
  .or({ ...STEP_BASE, do: "'assign'", target: ReviewTargetSchema.or({ "+": "reject", to: "'author'" }) })
  .or({ ...STEP_BASE, do: "'request-review'", target: ReviewTargetSchema })
  .or({ ...STEP_BASE, do: "'comment'", target: { "+": "reject", body: type(/\S/).atMostLength(COMMENT_BODY_MAX) } })
  .or({ ...STEP_BASE, do: "'approve' | 'merge' | 'close' | 'request-changes' | 'nothing'" });

export const stepListSchema = StepSchema.array().atMostLength(STEPS_MAX);

/** Packs written before verdicts stored an empty list of actions, which reads as no steps. */
const PolicyActionsObject = type({
  "+": "reject",
  when: type.enumerated(...POLICY_EVENTS).array().atLeastLength(1),
  pass: stepListSchema,
  fail: stepListSchema,
  unsure: stepListSchema,
});
const PolicyActionsSchema = PolicyActionsObject.or(type("unknown[]").atMostLength(0));

const EVIDENCE = /^(?:(?:[\w.-]+\/[\w.-]+)?#\d+|https:\/\/\S+|maintainer-stated)$/;
const EVIDENCE_MAX = 20;
export const Evidence = type(EVIDENCE).atMostLength(LINE_MAX).array().atLeastLength(1).atMostLength(EVIDENCE_MAX);
const NOTE = { "text?": Text, "reason?": Text, "evidence?": Evidence } as const;

const CatalogCheckSchema = type({
  ...NOTE,
  enabled: "boolean",
  "maxFiles?": "number",
  "maxLines?": "number",
  "tracker?": type.enumerated(...ISSUE_TRACKERS),
  "forbiddenGlobs?": "string[]",
});

export const CustomId = type(CUSTOM_ID).atMostLength(CUSTOM_ID_MAX);
const CUSTOM_BASE = { ...NOTE, id: CustomId, name: Text, group: type.enumerated(...CHECK_PACK_GROUPS), "enabled?": "boolean" } as const;
const MODEL = { ...CUSTOM_BASE, kind: "'model'" } as const;

const CustomCheckSchema = type({ ...MODEL, shape: "'is-true'", claim: Text, "scope?": type.enumerated(...CUSTOM_SCOPES), "when?": Texts })
  .or({ ...MODEL, shape: "'score'", subject: Text, levels: Text.array().atLeastLength(LEVELS_MIN).atMostLength(LEVELS_MAX), "failBelow?": Text })
  .or({ ...MODEL, shape: "'choose'", options: Text.array().atLeastLength(2), failOn: Texts })
  .or({ ...CUSTOM_BASE, kind: "'text'", fields: type.enumerated(...TEXT_FIELDS).array().atLeastLength(1), failWhen: type.enumerated(...TEXT_MATCHES), phrases: Texts });

const CatalogChecksSchema = type(
  Object.fromEntries(CATALOG_IDS.map((id) => [`${id}?`, CatalogCheckSchema])) as Record<`${CatalogId}?`, typeof CatalogCheckSchema>,
);

/**
 * Published as JSON Schema. `readCheckPack` stays the authority: it also drops unknown catalog rows, checks ids,
 * choices and levels, and leaves out steps for a role.
 */
export const checkPackSchema = type({
  kind: type.unit(CHECK_PACK_KIND),
  schemaVersion: type.unit(CHECK_PACK_SCHEMA_VERSION),
  repo: RepoName,
  "checks?": CatalogChecksSchema,
  "custom?": CustomCheckSchema.array().atMostLength(CUSTOM_CHECK_CAP),
  "actions?": PolicyActionsSchema,
  "labels?": { "+": "reject", "pass?": Label, "fail?": Label, "unsure?": Label },
});

/** `readSharedPolicy` stays the authority. */
export const sharedPolicySchema = checkPackSchema.omit("repo");

const OverrideChecksSchema = type(
  Object.fromEntries(CATALOG_IDS.map((id) => [`${id}?`, CatalogCheckSchema.partial()])) as Record<`${CatalogId}?`, ReturnType<typeof CatalogCheckSchema.partial>>,
);

/** `readPolicyOverride` stays the authority. */
export const policyOverrideSchema = checkPackSchema.omit("checks", "actions").and({
  extends: Text,
  "checks?": OverrideChecksSchema,
  "actions?": PolicyActionsObject.partial(),
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
    labels: { ...VERDICT_LABELS },
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
    custom: [{ ...RECOMMENDED_TEXT, fields: [...RECOMMENDED_TEXT.fields], phrases: [...RECOMMENDED_TEXT.phrases] }],
    actions: { ...defaultActions(), pass: [{ do: "approve" }] },
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
  const check: CatalogCheck = { enabled: row.enabled === false ? false : true, ...parseNote(row, CHECK_CATALOG[id].name) };
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

/** Policy text reaches the decision model and GitHub, so a single-line field keeps no line breaks, control or bidi characters; emoji sequences stay whole. */
function text(value: unknown, where: string, max = LINE_MAX): string {
  const line = typeof value === "string" ? value.replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\s]+/gu, " ").trim() : "";
  if (!line) throw new Error(`${where} must be a non-empty string.`);
  if (line.length > max) throw new Error(`${where} must be at most ${max} characters.`);
  return line;
}

/** A comment keeps its line breaks and tabs, and drops every other control or bidi character. */
function prose(value: unknown, where: string): string {
  const body = typeof value === "string" ? value.replace(/[^\P{Cc}\n\t]|[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "").trim() : "";
  if (!body) throw new Error(`${where} must be a non-empty string.`);
  if (body.length > COMMENT_BODY_MAX) throw new Error(`${where} must be at most ${COMMENT_BODY_MAX} characters.`);
  return body;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${where} must be a non-empty list.`);
  if (value.length > LIST_MAX) throw new Error(`${where} must list at most ${LIST_MAX}.`);
  return value;
}

function texts(value: unknown, where: string, max = LINE_MAX): string[] {
  const out = new Set<string>();
  for (const item of list(value, where)) out.add(text(item, where, max));
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

function distinctTexts(value: unknown, where: string): string[] {
  const out = list(value, where).map((item) => text(item, where));
  if (new Set(out).size !== out.length) throw new Error(`${where} must not repeat a value.`);
  return out;
}

function parseEvidence(value: unknown, where: string): string[] {
  const refs = texts(value, where);
  if (refs.length > EVIDENCE_MAX) throw new Error(`${where} must list at most ${EVIDENCE_MAX}.`);
  const bad = refs.find((ref) => !EVIDENCE.test(ref));
  if (bad !== undefined) throw new Error(`${where} must be pull request references (#44 or owner/name#44), https links or ${MAINTAINER_STATED}, not ${bad}.`);
  return refs;
}

function parseNote(row: Record<string, unknown>, where: string): RuleNote {
  return {
    ...(row.text !== undefined && { text: text(row.text, `${where} text`) }),
    ...(row.reason !== undefined && { reason: text(row.reason, `${where} reason`) }),
    ...(row.evidence !== undefined && { evidence: parseEvidence(row.evidence, `${where} evidence`) }),
  };
}

function parseScore(row: Record<string, unknown>, where: string): ModelCheck {
  const levels = distinctTexts(row.levels, `${where} levels`);
  if (levels.length < LEVELS_MIN || levels.length > LEVELS_MAX) throw new Error(`${where} levels must list ${LEVELS_MIN} to ${LEVELS_MAX} levels.`);
  if (row.failBelow === undefined) return { shape: "score", subject: text(row.subject, `${where} subject`), levels };
  const failBelow = text(row.failBelow, `${where} failBelow`);
  if (levels.indexOf(failBelow) < 1) throw new Error(`${where} failBelow must be one of the levels after the first.`);
  return { shape: "score", subject: text(row.subject, `${where} subject`), levels, failBelow };
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
      return parseScore(row, where);
    case "choose": {
      const options = distinctTexts(row.options, `${where} options`);
      if (options.length < 2) throw new Error(`${where} options must list at least two choices.`);
      const failOn = distinctTexts(row.failOn, `${where} failOn`);
      if (failOn.some((option) => !options.includes(option))) throw new Error(`${where} failOn must be among options.`);
      return { shape, options, failOn };
    }
  }
}

function parseText(row: Record<string, unknown>, where: string): TextCheck {
  const fields = new Set(list(row.fields, `${where} fields`).map((field) => oneOf(field, TEXT_FIELDS, `${where} fields`)));
  return { fields: TEXT_FIELDS.filter((field) => fields.has(field)), failWhen: oneOf(row.failWhen, TEXT_MATCHES, `${where} failWhen`), phrases: texts(row.phrases, `${where} phrases`) };
}

function parseCustomRow(row: Record<string, unknown>, index: number): CustomCheck {
  const where = `Custom rule ${typeof row.id === "string" ? row.id : index + 1}`;
  if (typeof row.id !== "string") throw new Error(`${where} id must be a string.`);
  const problem = customIdProblem(row.id);
  if (problem) throw new Error(`${where} id ${problem}.`);
  if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw new Error(`${where} enabled must be true or false.`);
  if (row.kind === "rule") throw new Error(`${where} is a ${String(row.rule)} rule over GitHub data, which Triage no longer runs; remove it.`);
  const kind = oneOf(row.kind, ["model", "text"] as const, `${where} kind`);
  const base = { id: row.id, name: text(row.name, `${where} name`), group: oneOf(row.group, CHECK_PACK_GROUPS, `${where} group`), ...(row.enabled === false && { enabled: false }), ...parseNote(row, where) };
  return kind === "text" ? { ...base, kind, ...parseText(row, where) } : { ...base, kind, ...parseModel(row, where) };
}

/** The last row of an id wins. */
function parseCustom(raw: unknown): CustomCheck[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("custom must be a list.");
  const byId = new Map<string, CustomCheck>();
  for (const [index, item] of raw.entries()) {
    const check = parseCustomRow(record(item, `Custom rule ${index + 1}`), index);
    if (!byId.has(check.id) && byId.size >= CUSTOM_CHECK_CAP) throw new Error(`Policy must have at most ${CUSTOM_CHECK_CAP} custom rules.`);
    byId.set(check.id, check);
  }
  return [...byId.values()];
}

function parseLabelsTarget(target: Record<string, unknown>, where: string): LabelsTarget {
  const from = oneOf(target.from, ["list", "rules"] as const, `${where} from`);
  if (from !== "list") {
    exactKeys(target, ["from"], where);
    return { from };
  }
  exactKeys(target, ["from", "labels"], where);
  return { from, labels: texts(target.labels, `${where} labels`, LABEL_MAX) };
}

function parsePeopleTarget(target: Record<string, unknown>, allowAuthor: boolean, where: string): PeopleTarget {
  const kinds = allowAuthor ? (["users", "teams", "codeowners", "author"] as const) : (["users", "teams", "codeowners"] as const);
  const to = oneOf(target.to, kinds, `${where} to`);
  if (to === "codeowners" || to === "author") {
    exactKeys(target, ["to"], where);
    return { to };
  }
  exactKeys(target, ["to", to], where);
  if (to === "users") return { to, users: texts(target.users, `${where} users`) };
  return { to, teams: texts(target.teams, `${where} teams`) };
}

function parseAuthorMatch(raw: unknown, where: string): AuthorMatch {
  if (typeof raw === "string") return oneOf(raw, AUTHOR_KINDS, where);
  const row = record(raw, where);
  if ("team" in row) {
    exactKeys(row, ["team"], where);
    return { team: text(row.team, `${where} team`) };
  }
  exactKeys(row, ["users"], where);
  return { users: texts(row.users, `${where} users`).map((login) => login.replace(/^@/, "")) };
}

function parseBound(raw: unknown, where: string): SizeBound {
  const row = record(raw, where);
  const extra = Object.keys(row).filter((key) => key !== "over" && key !== "atMost");
  if (extra.length || Object.keys(row).length === 0) throw new Error(`${where} must set over, atMost or both.`);
  const bound: SizeBound = {};
  for (const key of ["over", "atMost"] as const) {
    if (row[key] === undefined) continue;
    if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0) throw new Error(`${where} ${key} must be a whole number.`);
    bound[key] = row[key] as number;
  }
  if (bound.over !== undefined && bound.atMost !== undefined && bound.atMost <= bound.over) throw new Error(`${where} atMost must be more than over.`);
  return bound;
}

const WHEN_KEYS = ["author", "linkedIssue", "ci", "files", "lines"] as const;

function parseStepWhen(raw: unknown, where: string): StepWhen {
  const row = record(raw, where);
  const extra = Object.keys(row).filter((key) => !(WHEN_KEYS as readonly string[]).includes(key));
  if (extra.length) throw new Error(`${where} must set only ${WHEN_KEYS.join(", ")}, not ${extra.join(", ")}.`);
  if (Object.keys(row).length === 0) throw new Error(`${where} must set a condition, or be left out.`);
  const when: StepWhen = {};
  if (row.author !== undefined) when.author = list(row.author, `${where} author`).flatMap(authorKinds).map((item) => parseAuthorMatch(item, `${where} author`));
  if (row.linkedIssue !== undefined) {
    if (typeof row.linkedIssue !== "boolean") throw new Error(`${where} linkedIssue must be true or false.`);
    when.linkedIssue = row.linkedIssue;
  }
  if (row.ci !== undefined) {
    const states = new Set(list(row.ci, `${where} ci`).map((state) => oneOf(state, CI_STATES, `${where} ci`)));
    when.ci = CI_STATES.filter((state) => states.has(state));
  }
  if (row.files !== undefined) when.files = parseBound(row.files, `${where} files`);
  if (row.lines !== undefined) when.lines = parseBound(row.lines, `${where} lines`);
  return when;
}

/** A step written before conditions named who it is for; `for: anyone` held no condition. */
function stepCondition(row: Record<string, unknown>, where: string): StepWhen | undefined {
  if (row.for !== undefined && row.when !== undefined) throw new Error(`${where} must set when, not for and when.`);
  if (row.when !== undefined) return parseStepWhen(row.when, `${where} when`);
  if (row.for === undefined || row.for === "anyone") return undefined;
  return { author: authorKinds(row.for).map((item) => parseAuthorMatch(item, `${where} for`)) };
}

function parseStep(row: Record<string, unknown>, where: string): Step {
  const extra = Object.keys(row).filter((key) => row[key] !== undefined && !["do", "target", "for", "when"].includes(key));
  if (extra.length) throw new Error(`${where} must not set ${extra.join(", ")}.`);
  const kind = oneOf(row.do, STEP_KINDS, `${where} do`);
  const at = `${where} target`;
  const when = stepCondition(row, where);
  const step = when === undefined ? {} : { when };
  switch (kind) {
    case "labels":
      return { do: kind, target: parseLabelsTarget(record(row.target, at), at), ...step };
    case "assign":
      return { do: kind, target: parsePeopleTarget(record(row.target, at), true, at), ...step };
    case "request-review":
      return { do: kind, target: parsePeopleTarget(record(row.target, at), false, at) as ReviewTarget, ...step };
    case "comment": {
      const target = record(row.target, at);
      exactKeys(target, ["body"], at);
      const body = prose(target.body, `${at} body`);
      return { do: kind, target: { body }, ...step };
    }
    case "approve":
    case "merge":
    case "close":
    case "request-changes":
    case "nothing":
      if (row.target !== undefined) exactKeys(record(row.target, at), [], at);
      return { do: kind, ...step };
  }
}

/** Repository roles were removed, so a step for one is left out and named in `dropped`. */
function parseList(raw: unknown, where: string, dropped: string[]): Step[] {
  if (!Array.isArray(raw)) throw new Error(`${where} must be a list.`);
  if (raw.length > STEPS_MAX) throw new Error(`${where} must list at most ${STEPS_MAX} steps.`);
  return raw.flatMap(function stepAt(item, i) {
    const at = `${where} ${i + 1}`;
    const row = record(item, at);
    const role = asRecord(row.target)?.to === "role" ? asRecord(row.target)?.role : undefined;
    if (role === undefined) return [parseStep(row, at)];
    dropped.push(`${at} (${String(row.do)} role ${String(role)}) no longer runs`);
    return [];
  });
}

function parseEvents(raw: unknown, where: string): PolicyEvent[] {
  const events = new Set<PolicyEvent>();
  for (const event of list(raw, where)) events.add(oneOf(event, POLICY_EVENTS, where));
  return POLICY_EVENTS.filter((event) => events.has(event));
}

/** The same step listed twice runs once. */
function distinctSteps(steps: Step[]): Step[] {
  const seen = new Set<string>();
  return steps.filter(function first(step) {
    const key = JSON.stringify(step);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseLabels(raw: unknown): Record<VerdictWord, string> {
  if (raw === undefined) return { ...VERDICT_LABELS };
  const row = record(raw, "labels");
  const extra = Object.keys(row).filter((key) => !(VERDICTS as readonly string[]).includes(key));
  if (extra.length) throw new Error(`labels must set only pass, fail or unsure, not ${extra.join(", ")}.`);
  return Object.fromEntries(VERDICTS.map((verdict) => [verdict, row[verdict] === undefined ? VERDICT_LABELS[verdict] : text(row[verdict], `labels ${verdict}`, LABEL_MAX)])) as Record<VerdictWord, string>;
}

/** Packs written before verdicts stored an empty list of actions; one that is not empty is no longer read. */
function parseActions(raw: unknown, dropped: string[]): PolicyActions {
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return { when: [...POLICY_EVENTS], pass: [], fail: [], unsure: [] };
  if (Array.isArray(raw)) throw new Error("Actions must be { when, pass, fail, unsure }; a list of actions with yes, no, unsure and always branches is no longer read.");
  const row = record(raw, "Actions");
  exactKeys(row, ["when", ...VERDICTS], "Actions");
  return {
    when: parseEvents(row.when, "Actions when"),
    pass: distinctSteps(parseList(row.pass, "Pass step", dropped)),
    fail: distinctSteps(parseList(row.fail, "Fail step", dropped)),
    unsure: distinctSteps(parseList(row.unsure, "Unsure step", dropped)),
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

/** A version 1 Do as a step for anyone, or why it is left out: it no longer runs, or labels derived from the pull request never ran. */
function stepOfDo(raw: unknown, where: string, dropped: string[]): unknown[] {
  const row = record(raw, where);
  const target = asRecord(row.target);
  const from = target?.from;
  if (!(STEP_KINDS as readonly unknown[]).includes(row.kind) || (row.kind === "labels" && from !== "list")) {
    dropped.push(`${where} (${String(row.kind)}${from === undefined ? "" : ` from ${String(from)}`}) no longer runs`);
    return [];
  }
  return [target && Object.keys(target).length > 0 ? { do: row.kind, target } : { do: row.kind }];
}

/** Text a version 1 pack stored longer than version 2 holds is cut, and said so, rather than costing the whole pack. */
function cutText(value: unknown, where: string, dropped: string[], max = LINE_MAX): unknown {
  if (typeof value !== "string" || value.trim().length <= max) return value;
  dropped.push(`${where} was cut to ${max} characters`);
  return value.trim().slice(0, max);
}

function cutCustom(raw: unknown, index: number, dropped: string[]): unknown[] {
  const row = asRecord(raw);
  if (!row) return [raw];
  const where = `Custom rule ${typeof row.id === "string" ? row.id : index + 1}`;
  if (row.kind === "rule") {
    dropped.push(`${where} (${String(row.rule)} rule over GitHub data) no longer runs`);
    return [];
  }
  const cut = Object.fromEntries(["name", "claim", "subject"].flatMap((key) => (key in row ? [[key, cutText(row[key], `${where} ${key}`, dropped)]] : [])));
  const lists = Object.fromEntries(["levels", "options", "failOn"].flatMap((key) => (Array.isArray(row[key]) ? [[key, (row[key] as unknown[]).map((item) => cutText(item, `${where} ${key}`, dropped))]] : [])));
  return [{ ...row, ...cut, ...lists }];
}

/**
 * A version 1 pack read as version 2: its lists of Dos become steps for anyone, and its custom rules over GitHub data
 * and over-long text are left out or cut, each named in `dropped`. A list of actions with branches cannot be mapped.
 */
function fromVersion1(body: Record<string, unknown>, dropped: string[]): Record<string, unknown> {
  const custom = Array.isArray(body.custom) ? body.custom.flatMap((row, index) => cutCustom(row, index, dropped)) : body.custom;
  const lists = asRecord(body.actions);
  if (!lists || Array.isArray(body.actions)) return { ...body, custom };
  const steps = Object.fromEntries(VERDICTS.map((verdict) => [verdict, Array.isArray(lists[verdict]) ? (lists[verdict] as unknown[]).flatMap((item, i) => stepOfDo(item, `${LIST_NAMES[verdict]} step ${i + 1}`, dropped)) : lists[verdict]]));
  return { ...body, custom, actions: { ...lists, ...steps } };
}

const LIST_NAMES: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };

function policyObject(raw: unknown): Record<string, unknown> {
  const body = asRecord(parseJson(raw));
  if (!body) throw new Error("Policy must be an object.");
  if (body.kind !== CHECK_PACK_KIND) throw new Error(`kind must be ${CHECK_PACK_KIND}.`);
  return body;
}

function currentVersion(body: Record<string, unknown>): void {
  if (body.schemaVersion !== CHECK_PACK_SCHEMA_VERSION) throw new Error(`schemaVersion must be ${CHECK_PACK_SCHEMA_VERSION}.`);
}

function readRepo(body: Record<string, unknown>, expectedRepo: string | undefined): string {
  const repo = asRepo(body.repo);
  if (!repo) throw new Error("repo must be owner/name.");
  if (expectedRepo !== undefined && asRepo(expectedRepo) !== repo) throw new Error(`repo must be ${expectedRepo}.`);
  return repo;
}

function readChecks(raw: unknown): CheckPack["checks"] {
  const checksRaw = raw === undefined ? {} : asRecord(raw);
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
  return checks;
}

function withDropped<T extends object>(read: T, dropped: string[]): T & { dropped?: string[] } {
  return { ...read, ...(dropped.length > 0 && { dropped }) };
}

/** Reads a stored pack, throwing an Error whose message says why it is rejected. Version 1 reads as version 2. */
export function readCheckPack(raw: unknown, expectedRepo?: string): CheckPack {
  const stored = policyObject(raw);
  if (stored.schemaVersion !== LEGACY_SCHEMA_VERSION) currentVersion(stored);
  const dropped: string[] = [];
  const body = stored.schemaVersion === LEGACY_SCHEMA_VERSION ? fromVersion1(stored, dropped) : stored;
  if (body.extends !== undefined) throw new Error("This policy extends a workspace policy and is read with it.");
  const repo = readRepo(body, expectedRepo);
  const checks = readChecks(body.checks);
  const custom = parseCustom(body.custom);
  const actions = parseActions(body.actions, dropped);
  const labels = parseLabels(body.labels);
  return withDropped({ kind: CHECK_PACK_KIND, schemaVersion: CHECK_PACK_SCHEMA_VERSION, repo, checks, custom, actions, labels }, dropped);
}

/** Workspace policy titles start with this, so the stock artifact list finds them with `?query=`. */
export const WORKSPACE_POLICY_TITLE_PREFIX = "workspace-policy/";

export type SharedPolicy = Omit<CheckPack, "repo">;

export type PolicyOverride = Pick<CheckPack, "repo" | "custom"> & {
  extends: string;
  checks: Partial<Record<CatalogId, Partial<CatalogCheck>>>;
  actions: Partial<PolicyActions>;
  labels: Partial<Record<VerdictWord, string>>;
};

export function extendsOf(raw: unknown): string | undefined {
  const value = asRecord(parseJson(raw))?.extends;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("extends must be a shared policy's id.");
  return value.trim();
}

export function readSharedPolicy(raw: unknown): SharedPolicy {
  const body = policyObject(raw);
  currentVersion(body);
  if (body.extends !== undefined) throw new Error("A shared policy must not extend another.");
  const checks = readChecks(body.checks);
  const dropped: string[] = [];
  const custom = parseCustom(body.custom);
  const actions = parseActions(body.actions, dropped);
  const labels = parseLabels(body.labels);
  return withDropped({ kind: CHECK_PACK_KIND, schemaVersion: CHECK_PACK_SCHEMA_VERSION, checks, custom, actions, labels }, dropped);
}

/** Built-in rule rows as a repository sets them: `enabled` only where the row names it, so a limit alone keeps the shared switch. */
function readOverrideChecks(raw: unknown): PolicyOverride["checks"] {
  const checks: PolicyOverride["checks"] = readChecks(raw);
  const switched = new Set(Object.entries(asRecord(raw) ?? {}).flatMap(([stored, value]) => (asRecord(value)?.enabled === undefined ? [] : currentRuleIds(stored))));
  for (const [id, row] of Object.entries(checks)) {
    if (!switched.has(id)) delete row.enabled;
  }
  return checks;
}

const STEP_WHERE: Record<VerdictWord, string> = { pass: "Pass step", fail: "Fail step", unsure: "Unsure step" };

/** The schema has already refused an unknown list or a step for a removed role, so nothing is dropped. */
function parseOverrideActions(row: Partial<Record<"when" | VerdictWord, unknown>> | undefined): Partial<PolicyActions> {
  const actions: Partial<PolicyActions> = {};
  if (row?.when !== undefined) actions.when = parseEvents(row.when, "Actions when");
  for (const verdict of VERDICTS) {
    if (row?.[verdict] !== undefined) actions[verdict] = distinctSteps(parseList(row[verdict], STEP_WHERE[verdict], []));
  }
  return actions;
}

function parseOverrideLabels(row: Partial<Record<VerdictWord, unknown>> | undefined): PolicyOverride["labels"] {
  const labels: PolicyOverride["labels"] = {};
  for (const verdict of VERDICTS) {
    if (row?.[verdict] !== undefined) labels[verdict] = text(row[verdict], `labels ${verdict}`, LABEL_MAX);
  }
  return labels;
}

export function readPolicyOverride(raw: unknown, expectedRepo?: string): PolicyOverride {
  const body = policyOverrideSchema(withAuthorKinds(parseJson(raw)));
  if (body instanceof type.errors) throw new Error(body.summary);
  return {
    repo: readRepo(body, expectedRepo),
    extends: body.extends.trim(),
    checks: readOverrideChecks(body.checks),
    custom: parseCustom(body.custom),
    actions: parseOverrideActions(body.actions),
    labels: parseOverrideLabels(body.labels),
  };
}


const RULE_LABEL_PREFIX = "rule: ";

export function ruleLabel(id: string): string {
  return `${RULE_LABEL_PREFIX}${id}`;
}

export function stepTeams(pack: CheckPack): string[] {
  return [...new Set(VERDICTS.flatMap((list) => pack.actions[list].flatMap((step) => (step.when?.author ?? []).flatMap((match) => (typeof match === "object" && "team" in match ? [match.team] : [])))))];
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

const CI_ACTIONS = new Set<Step["do"]>(["approve", "merge"]);

/** The policy reads CI: ci-green is on, or a step names a CI condition or acts only on green CI. */
export function dependsOnCi(pack: CheckPack): boolean {
  if (catalogCheckEnabled(pack, "ci-green")) return true;
  return VERDICTS.some((verdict) => pack.actions[verdict].some((step) => step.when?.ci !== undefined || CI_ACTIONS.has(step.do)));
}

/** Whether any rule is switched on; with none, triage has nothing to decide and the hub starts no run. */
export function hasEnabledRules(pack: CheckPack): boolean {
  return CATALOG_IDS.some((id) => catalogCheckEnabled(pack, id)) || pack.custom.some(customCheckEnabled);
}

export function isModelCheck(row: CustomCheck): row is ModelCustomCheck {
  return row.kind === "model";
}

export function isTextCheck(row: CustomCheck): row is TextCustomCheck {
  return row.kind === "text";
}

export function classificationSources(pack: CheckPack): { quality: Array<{ id: QualityCheckId; group: CheckPackGroup }>; custom: ModelCustomCheck[] } {
  return {
    quality: QUALITY_CHECK_IDS.filter((id) => catalogCheckEnabled(pack, id)).map((id) => ({ id, group: CHECK_CATALOG[id].group })),
    custom: pack.custom.filter(isModelCheck).filter(customCheckEnabled),
  };
}
