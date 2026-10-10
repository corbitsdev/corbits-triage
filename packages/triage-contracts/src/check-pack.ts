import { type } from "arktype";

export const CHECK_PACK_KIND = "corbits.triage.check-pack";
export const CHECK_PACK_SCHEMA_VERSION = 1;
export const CUSTOM_CHECK_CAP = 8;

export const CHECK_PACK_GROUPS = ["pull-request", "issue", "around", "code-vs-ci"] as const;
export type CheckPackGroup = (typeof CHECK_PACK_GROUPS)[number];

export const CATALOG_IDS = [
  "draft",
  "size",
  "duplicate",
  "focused",
  "docs",
  "issue",
  "reviewers",
  "conflicts",
  "drift",
  "ci",
  "tests",
  "paths",
] as const;
export type CatalogId = (typeof CATALOG_IDS)[number];

export const MACHINE_CHECK_IDS = ["draft", "size", "duplicate", "issue", "reviewers", "conflicts", "drift", "ci", "paths"] as const;
export type MachineCheckId = (typeof MACHINE_CHECK_IDS)[number];

export const QUALITY_CHECK_IDS = ["focused", "docs", "tests"] as const;
export type QualityCheckId = (typeof QUALITY_CHECK_IDS)[number];

export const ISSUE_TRACKERS = ["github", "linear", "either", "off"] as const;
export type IssueTracker = (typeof ISSUE_TRACKERS)[number];

export const CHECK_CATALOG: Record<CatalogId, { group: CheckPackGroup; kind: "machine" | "quality" }> = {
  draft: { group: "pull-request", kind: "machine" },
  size: { group: "pull-request", kind: "machine" },
  duplicate: { group: "pull-request", kind: "machine" },
  focused: { group: "pull-request", kind: "quality" },
  docs: { group: "pull-request", kind: "quality" },
  issue: { group: "issue", kind: "machine" },
  reviewers: { group: "around", kind: "machine" },
  conflicts: { group: "around", kind: "machine" },
  drift: { group: "around", kind: "machine" },
  ci: { group: "code-vs-ci", kind: "machine" },
  tests: { group: "code-vs-ci", kind: "quality" },
  paths: { group: "code-vs-ci", kind: "machine" },
};

export const RECOMMENDED_SIZE = { maxFiles: 20, maxLines: 500 } as const;
export const RECOMMENDED_DRIFT = { maxBehindBy: 50 } as const;
export const RECOMMENDED_PATHS = { forbiddenGlobs: ["vendor/**", "node_modules/**"] } as const;
export const RECOMMENDED_ISSUE = { tracker: "either", requireLabel: false, label: "" } as const;

export type CatalogCheck = {
  enabled: boolean;
  maxFiles?: number;
  maxLines?: number;
  tracker?: IssueTracker;
  requireLabel?: boolean;
  label?: string;
  maxBehindBy?: number;
  forbiddenGlobs?: string[];
};

export type CustomCheck = {
  id: string;
  name: string;
  group: CheckPackGroup;
  instruction: string;
};

export const ACTION_KINDS = ["labels", "assign", "request-review", "comment", "close", "agent"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

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

export type CheckRef = CatalogId | `custom-${number}`;

export type LabelsTarget = { from: "list"; labels: string[] } | { from: "type" } | { from: "paths" };
/** A role names an entry in the repository policy's roles, resolved at evaluation time. */
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

export type Do = { automatic: boolean } & (
  | { kind: "labels"; target: LabelsTarget }
  | { kind: "assign"; target: PeopleTarget }
  | { kind: "request-review"; target: ReviewTarget }
  | { kind: "comment"; target: CommentTarget }
  | { kind: "close"; target: CloseTarget }
  | { kind: "agent"; target: AgentTarget }
);

/** Branches follow the checks' combined verdict; without checks, `always` runs. */
export type Branches = { yes?: Do[]; no?: Do[]; unsure?: Do[] } | { always: Do[] };

export type Action = {
  id: string;
  when: "every" | TriageEvent[];
  checks: CheckRef[];
  branches: Branches;
};

export type CheckPack = {
  kind: typeof CHECK_PACK_KIND;
  schemaVersion: typeof CHECK_PACK_SCHEMA_VERSION;
  repo: string;
  checks: Partial<Record<CatalogId, CatalogCheck>>;
  custom: CustomCheck[];
  actions: Action[];
};

const Text = type(/\S/);
const Texts = Text.array().atLeastLength(1);
const RepoName = type(/^\s*(?!.*\.\.)(?!\.\/)[^\s\\/]+\/(?!\.\s*$)[^\s\\/]+\s*$/);

const ReviewTargetSchema = type({ "+": "reject", to: "'users'", users: Texts })
  .or({ "+": "reject", to: "'teams'", teams: Texts })
  .or({ "+": "reject", to: "'role'", role: Text })
  .or({ "+": "reject", to: "'codeowners'" });

const DoSchema = type({
  kind: "'labels'",
  automatic: "boolean",
  target: type({ "+": "reject", from: "'list'", labels: Texts }).or({ "+": "reject", from: "'type' | 'paths'" }),
})
  .or({ kind: "'assign'", automatic: "boolean", target: ReviewTargetSchema.or({ "+": "reject", to: "'author'" }) })
  .or({ kind: "'request-review'", automatic: "boolean", target: ReviewTargetSchema })
  .or({ kind: "'comment'", automatic: "boolean", target: { "+": "reject", body: Text } })
  .or({ kind: "'close'", automatic: "boolean", target: { "+": "reject" } })
  .or({ kind: "'agent'", automatic: "boolean", target: { "+": "reject", prompt: Text, tools: Text.array() } });

const ActionSchema = type({
  id: Text,
  when: type("'every'").or(type.enumerated(...TRIAGE_EVENTS.filter((event) => event !== "catch-up")).array().atLeastLength(1)),
  checks: Text.array(),
  branches: type({ "+": "reject", always: DoSchema.array().atLeastLength(1) }).or({
    "+": "reject",
    "yes?": DoSchema.array(),
    "no?": DoSchema.array(),
    "unsure?": DoSchema.array(),
  }),
});

const CatalogCheckSchema = type({
  enabled: "boolean",
  "maxFiles?": "number",
  "maxLines?": "number",
  "tracker?": type.enumerated(...ISSUE_TRACKERS),
  "requireLabel?": "boolean",
  "label?": "string",
  "maxBehindBy?": "number",
  "forbiddenGlobs?": "string[]",
});

const CustomCheckSchema = type({
  id: /^custom-\d+$/,
  name: Text,
  group: type.enumerated(...CHECK_PACK_GROUPS),
  instruction: Text,
});

const CatalogChecksSchema = type(
  Object.fromEntries(CATALOG_IDS.map((id) => [`${id}?`, CatalogCheckSchema])) as Record<`${CatalogId}?`, typeof CatalogCheckSchema>,
);

/**
 * Published as JSON Schema. `readCheckPack` stays the authority: it also drops catalog and custom rows it cannot read,
 * and checks references, branch sets and automatic steps.
 */
export const checkPackSchema = type({
  kind: type.unit(CHECK_PACK_KIND),
  schemaVersion: type.unit(CHECK_PACK_SCHEMA_VERSION),
  repo: RepoName,
  "checks?": CatalogChecksSchema,
  "custom?": CustomCheckSchema.array().atMostLength(CUSTOM_CHECK_CAP),
  "actions?": ActionSchema.array(),
});

const CATALOG_SET = new Set<string>(CATALOG_IDS);
const GROUP_SET = new Set<string>(CHECK_PACK_GROUPS);
const TRACKER_SET = new Set<string>(ISSUE_TRACKERS);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asRepo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const parts = trimmed.split("/");
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) return undefined;
  if (parts.some((part) => part === "." || part === "..") || trimmed.includes("..") || /[\s\\]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

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
    actions: [],
  };
}

export function recommendedPack(repo: string): CheckPack {
  const base = emptyPack(repo);
  return {
    ...base,
    checks: {
      draft: { enabled: true },
      size: { enabled: true, maxFiles: RECOMMENDED_SIZE.maxFiles, maxLines: RECOMMENDED_SIZE.maxLines },
      duplicate: { enabled: true },
      focused: { enabled: true },
      docs: { enabled: true },
      issue: {
        enabled: true,
        tracker: RECOMMENDED_ISSUE.tracker,
        requireLabel: RECOMMENDED_ISSUE.requireLabel,
        label: RECOMMENDED_ISSUE.label,
      },
      reviewers: { enabled: false },
      conflicts: { enabled: true },
      drift: { enabled: true, maxBehindBy: RECOMMENDED_DRIFT.maxBehindBy },
      ci: { enabled: true },
      tests: { enabled: true },
      paths: { enabled: true, forbiddenGlobs: [...RECOMMENDED_PATHS.forbiddenGlobs] },
    },
  };
}

export function applyRecommended(pack: CheckPack): CheckPack {
  const rec = recommendedPack(pack.repo);
  return { ...rec, custom: pack.custom, actions: pack.actions };
}

export function catalogCheckEnabled(pack: CheckPack, id: CatalogId): boolean {
  const row = pack.checks[id];
  return row !== undefined && row.enabled !== false;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseGlobs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const globs = value.flatMap((item) => (typeof item === "string" && item.trim().length > 0 ? [item.trim()] : []));
  return globs;
}

function parseCatalogCheck(id: CatalogId, raw: unknown): CatalogCheck | undefined {
  const row = asRecord(raw);
  if (!row) return undefined;
  const check: CatalogCheck = { enabled: row.enabled === false ? false : true };
  if (id === "size") {
    const maxFiles = finiteNumber(row.maxFiles);
    const maxLines = finiteNumber(row.maxLines);
    if (maxFiles !== undefined) check.maxFiles = maxFiles;
    if (maxLines !== undefined) check.maxLines = maxLines;
  }
  if (id === "issue") {
    if (typeof row.tracker === "string" && TRACKER_SET.has(row.tracker)) check.tracker = row.tracker as IssueTracker;
    if (typeof row.requireLabel === "boolean") check.requireLabel = row.requireLabel;
    if (typeof row.label === "string") check.label = row.label;
  }
  if (id === "drift") {
    const maxBehindBy = finiteNumber(row.maxBehindBy);
    if (maxBehindBy !== undefined) check.maxBehindBy = maxBehindBy;
  }
  if (id === "paths") {
    const globs = parseGlobs(row.forbiddenGlobs);
    if (globs) check.forbiddenGlobs = globs;
  }
  return check;
}

function parseCustom(raw: unknown): CustomCheck[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, CustomCheck>();
  let next = 1;
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const instruction = typeof row.instruction === "string" ? row.instruction.trim() : "";
    const group = typeof row.group === "string" ? row.group.trim() : "";
    if (!name || !instruction || !GROUP_SET.has(group)) continue;
    const requested = typeof row.id === "string" ? row.id.trim() : "";
    const id = /^custom-\d+$/.test(requested) ? requested : `custom-${next}`;
    const n = Number(id.slice("custom-".length));
    if (Number.isInteger(n) && n >= next) next = n + 1;
    else next += 1;
    if (!byId.has(id) && byId.size >= CUSTOM_CHECK_CAP) continue;
    byId.set(id, { id, name, group: group as CheckPackGroup, instruction });
  }
  return [...byId.values()];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${where} must be one of ${allowed.join(", ")}.`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${where} must be a non-empty string.`);
  return value.trim();
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
  if (typeof row.automatic !== "boolean") throw new Error(`${where} automatic must be true or false.`);
  const automatic = row.automatic;
  const at = `${where} target`;
  const target = record(row.target, at);
  switch (kind) {
    case "labels":
      return { kind, automatic, target: parseLabelsTarget(target, at) };
    case "assign":
      return { kind, automatic, target: parsePeopleTarget(target, true, at) };
    case "request-review":
      return { kind, automatic, target: parsePeopleTarget(target, false, at) as ReviewTarget };
    case "comment": {
      exactKeys(target, ["body"], at);
      const body = text(target.body, `${at} body`);
      if (body.length > COMMENT_BODY_MAX) throw new Error(`${at} body must be at most ${COMMENT_BODY_MAX} characters.`);
      return { kind, automatic, target: { body } };
    }
    case "close":
      exactKeys(target, [], at);
      return { kind, automatic, target: {} };
    case "agent": {
      exactKeys(target, ["prompt", "tools"], at);
      if (!Array.isArray(target.tools)) throw new Error(`${at} tools must be a list.`);
      const tools = new Set<string>();
      for (const tool of target.tools) tools.add(text(tool, `${at} tools`));
      return { kind, automatic, target: { prompt: text(target.prompt, `${at} prompt`), tools: [...tools] } };
    }
  }
}

function parseBranch(raw: unknown, manualOnly: readonly ActionKind[], where: string): Do[] {
  if (!Array.isArray(raw)) throw new Error(`${where} must be a list.`);
  const dos: Do[] = [];
  for (const [i, item] of raw.entries()) {
    const step = parseDo(item, `${where} ${i + 1}`);
    if (step.automatic && manualOnly.includes(step.kind)) throw new Error(`${where} ${i + 1} cannot ${step.kind} automatically.`);
    dos.push(step);
  }
  return dos;
}

function parseBranches(raw: unknown, hasChecks: boolean, where: string): Branches {
  const row = record(raw, where);
  if (!hasChecks) {
    exactKeys(row, ["always"], where);
    const always = parseBranch(row.always, ["close", "agent"], `${where} always`);
    if (always.length === 0) throw new Error(`${where} always must not be empty.`);
    return { always };
  }
  const keys = Object.keys(row).filter((key) => row[key] !== undefined);
  if (keys.some((key) => key !== "yes" && key !== "no" && key !== "unsure")) {
    throw new Error(`${where} must set only yes, no and unsure.`);
  }
  const branches: { yes?: Do[]; no?: Do[]; unsure?: Do[] } = {};
  if (row.yes !== undefined) branches.yes = parseBranch(row.yes, [], `${where} yes`);
  if (row.no !== undefined) branches.no = parseBranch(row.no, [], `${where} no`);
  if (row.unsure !== undefined) branches.unsure = parseBranch(row.unsure, ["close"], `${where} unsure`);
  if (Object.values(branches).every((dos) => dos.length === 0)) throw new Error(`${where} must set at least one step.`);
  return branches;
}

function parseWhen(raw: unknown, where: string): Action["when"] {
  if (raw === "every") return raw;
  const events = new Set<TriageEvent>();
  for (const event of list(raw, where)) {
    const parsed = oneOf(event, TRIAGE_EVENTS, where);
    if (parsed === "catch-up") throw new Error(`${where} must not list catch-up; catch-up runs every action.`);
    events.add(parsed);
  }
  return [...events];
}

function parseCheckRefs(raw: unknown, customIds: ReadonlySet<string>, where: string): CheckRef[] {
  if (!Array.isArray(raw)) throw new Error(`${where} must be a list.`);
  const refs = new Set<CheckRef>();
  for (const item of raw) {
    const id = text(item, where);
    if (!CATALOG_SET.has(id) && !customIds.has(id)) {
      throw new Error(`${where} ${id} must be a catalog check or a custom check in this pack.`);
    }
    refs.add(id as CheckRef);
  }
  return [...refs];
}

function parseAction(raw: unknown, index: number, customIds: ReadonlySet<string>): Action {
  const row = record(raw, `Action ${index + 1}`);
  const id = text(row.id, `Action ${index + 1} id`);
  const where = `Action ${id}`;
  const when = parseWhen(row.when, `${where} when`);
  const checks = parseCheckRefs(row.checks, customIds, `${where} checks`);
  return { id, when, checks, branches: parseBranches(row.branches, checks.length > 0, `${where} branches`) };
}

function parseActions(raw: unknown, customIds: ReadonlySet<string>): Action[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("Actions must be a list.");
  const actions: Action[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const action = parseAction(item, index, customIds);
    if (seen.has(action.id)) throw new Error(`Action ${action.id} is defined more than once.`);
    seen.add(action.id);
    actions.push(action);
  }
  return actions;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Check pack must be JSON.");
  }
}

/** Reads a stored pack, throwing an Error whose message says why it is rejected. */
export function readCheckPack(raw: unknown, expectedRepo?: string): CheckPack {
  const body = asRecord(parseJson(raw));
  if (!body) throw new Error("Check pack must be an object.");
  if (body.kind !== CHECK_PACK_KIND) throw new Error(`kind must be ${CHECK_PACK_KIND}.`);
  if (body.schemaVersion !== CHECK_PACK_SCHEMA_VERSION) throw new Error(`schemaVersion must be ${CHECK_PACK_SCHEMA_VERSION}.`);
  const repo = asRepo(body.repo);
  if (!repo) throw new Error("repo must be owner/name.");
  if (expectedRepo !== undefined && asRepo(expectedRepo) !== repo) throw new Error(`repo must be ${expectedRepo}.`);
  const checksRaw = body.checks === undefined ? {} : asRecord(body.checks);
  if (!checksRaw) throw new Error("checks must be an object.");
  const checks: CheckPack["checks"] = {};
  for (const [id, value] of Object.entries(checksRaw)) {
    if (!CATALOG_SET.has(id)) continue;
    const parsed = parseCatalogCheck(id as CatalogId, value);
    if (parsed) checks[id as CatalogId] = parsed;
  }
  const custom = parseCustom(body.custom);
  const actions = parseActions(body.actions, new Set(custom.map((row) => row.id)));
  return {
    kind: CHECK_PACK_KIND,
    schemaVersion: CHECK_PACK_SCHEMA_VERSION,
    repo,
    checks,
    custom,
    actions,
  };
}

export function parseCheckPack(raw: unknown, expectedRepo?: string): CheckPack | null {
  try {
    return readCheckPack(raw, expectedRepo);
  } catch {
    return null;
  }
}

/** Custom instructions are handed to the classifier as plain text, never evaluated. */
export function classificationSources(pack: CheckPack): {
  quality: Array<{ id: QualityCheckId; group: CheckPackGroup }>;
  custom: Array<{ id: string; name: string; group: CheckPackGroup; instruction: string }>;
} {
  return {
    quality: QUALITY_CHECK_IDS.filter((id) => catalogCheckEnabled(pack, id)).map((id) => ({
      id,
      group: CHECK_CATALOG[id].group,
    })),
    custom: pack.custom.map(({ id, name, group, instruction }) => ({ id, name, group, instruction })),
  };
}
