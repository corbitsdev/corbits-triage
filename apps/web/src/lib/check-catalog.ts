import {
  CHECK_PACK_KIND,
  CHECK_PACK_SCHEMA_VERSION,
  parseCheckPack,
  type CatalogCheck as PackCatalogCheck,
  type CatalogId,
  type CheckPack,
  type CheckPackGroup,
  type CleanupMode,
  type CustomCheck,
  type IssueTracker,
} from "@corbits/triage-contracts";

export const CHECK_GROUPS = [
  { id: "pr", label: "Pull request" },
  { id: "issue", label: "Issue" },
  { id: "around", label: "Around it" },
  { id: "code", label: "Code vs CI" },
] as const;

export type CheckGroupId = (typeof CHECK_GROUPS)[number]["id"];

export type CatalogCheck = {
  id: string;
  group: CheckGroupId;
  kind: "machine" | "quality";
  param?: "number" | "select" | "text" | "globs";
  valueKey?: string;
  defaultValue?: string | number | string[];
  min?: number;
  options?: Array<{ value: string; label: string }>;
};

export const CHECK_CATALOG: CatalogCheck[] = [
  { id: "files", group: "pr", kind: "machine", param: "number", valueKey: "maxFiles", defaultValue: 20, min: 1 },
  { id: "size", group: "pr", kind: "machine", param: "number", valueKey: "maxLines", defaultValue: 500, min: 1 },
  { id: "focused", group: "pr", kind: "quality" },
  { id: "duplicate", group: "pr", kind: "machine" },
  { id: "draft", group: "pr", kind: "machine" },
  { id: "issue", group: "issue", kind: "machine", param: "select", valueKey: "tracker", defaultValue: "either", options: [
    { value: "github", label: "GitHub" },
    { value: "linear", label: "Linear" },
    { value: "either", label: "GitHub or Linear" },
    { value: "none", label: "Not required" },
  ] },
  { id: "issueLabel", group: "issue", kind: "machine", param: "text", valueKey: "label", defaultValue: "" },
  { id: "reviewers", group: "around", kind: "machine" },
  { id: "drift", group: "around", kind: "machine", param: "number", valueKey: "maxCommits", defaultValue: 50, min: 0 },
  { id: "conflicts", group: "around", kind: "machine" },
  { id: "ci", group: "code", kind: "machine" },
  { id: "tests", group: "code", kind: "quality" },
  { id: "paths", group: "code", kind: "machine", param: "globs", valueKey: "globs", defaultValue: ["vendor/**", "node_modules/**"] },
  { id: "docs", group: "code", kind: "quality" },
];

export type DraftCheck = {
  id: string;
  enabled: boolean;
  custom?: boolean;
  name?: string;
  group?: CheckGroupId;
  instruction?: string;
  values: Record<string, string | number | string[]>;
};

export type DraftPack = {
  repository: string;
  mode: CleanupMode;
  checks: DraftCheck[];
  custom: DraftCheck[];
};

const DIRECT_IDS = new Set<CatalogId>(["draft", "duplicate", "focused", "docs", "reviewers", "conflicts", "ci", "tests"]);

function toPackGroup(id: CheckGroupId): CheckPackGroup {
  if (id === "pr") return "pull-request";
  if (id === "code") return "code-vs-ci";
  return id;
}

function fromPackGroup(id: CheckPackGroup): CheckGroupId {
  if (id === "pull-request") return "pr";
  if (id === "code-vs-ci") return "code";
  return id;
}

function rowById(pack: DraftPack, id: string): DraftCheck | undefined {
  return pack.checks.find((row) => row.id === id);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function emptyDraft(repository: string, mode: CleanupMode = "human-approved"): DraftPack {
  return { repository, mode, checks: [], custom: [] };
}

export const emptyPack = emptyDraft;

function customCheckFromDraft(row: DraftPack["custom"][number], index: number): CustomCheck[] {
  const name = (row.name ?? "").trim();
  const instruction = (row.instruction ?? "").trim();
  const group = row.group ?? "pr";
  if (!name || !instruction) return [];
  return [{
    id: /^custom-\d+$/.test(row.id) ? row.id : `custom-${index + 1}`,
    name,
    group: toPackGroup(group),
    instruction,
  }];
}

export function checkPackFromDraft(pack: DraftPack): CheckPack {
  const checks: CheckPack["checks"] = {};
  const files = rowById(pack, "files");
  const size = rowById(pack, "size");
  if (files || size) {
    const row: PackCatalogCheck = { enabled: Boolean(files?.enabled || size?.enabled) };
    if (files) row.maxFiles = finiteNumber(files.values.maxFiles, 20);
    if (size) row.maxLines = finiteNumber(size.values.maxLines, 500);
    checks.size = row;
  }
  const issue = rowById(pack, "issue");
  const issueLabel = rowById(pack, "issueLabel");
  if (issue || issueLabel) {
    const trackerRaw = issue ? String(issue.values.tracker ?? "either") : "either";
    const tracker = (trackerRaw === "none" ? "off" : trackerRaw) as IssueTracker;
    checks.issue = {
      enabled: issue?.enabled ?? issueLabel?.enabled ?? true,
      tracker,
      requireLabel: issueLabel ? issueLabel.enabled : false,
      label: issueLabel ? String(issueLabel.values.label ?? "") : "",
    };
  }
  const drift = rowById(pack, "drift");
  if (drift) {
    checks.drift = { enabled: drift.enabled, maxBehindBy: finiteNumber(drift.values.maxCommits, 50) };
  }
  const paths = rowById(pack, "paths");
  if (paths) {
    const globs = Array.isArray(paths.values.globs)
      ? paths.values.globs.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    checks.paths = { enabled: paths.enabled, forbiddenGlobs: globs };
  }
  for (const id of DIRECT_IDS) {
    const row = rowById(pack, id);
    if (row) checks[id] = { enabled: row.enabled };
  }
  const custom = pack.custom.flatMap(customCheckFromDraft);
  const parsed = parseCheckPack({
    kind: CHECK_PACK_KIND,
    schemaVersion: CHECK_PACK_SCHEMA_VERSION,
    repo: pack.repository,
    checks,
    custom,
  }, pack.repository);
  if (!parsed) throw new Error("Check pack is not valid.");
  return parsed;
}

export function draftFromCheckPack(pack: CheckPack, mode: CleanupMode = "human-approved"): DraftPack {
  const byId = new Map<string, DraftCheck>();
  const size = pack.checks.size;
  if (size) {
    const hasFiles = size.maxFiles !== undefined;
    const hasLines = size.maxLines !== undefined;
    if (hasFiles || (!hasFiles && !hasLines)) {
      byId.set("files", { id: "files", enabled: size.enabled, values: { maxFiles: size.maxFiles ?? 20 } });
    }
    if (hasLines || (!hasFiles && !hasLines)) {
      byId.set("size", { id: "size", enabled: size.enabled, values: { maxLines: size.maxLines ?? 500 } });
    }
  }
  const issue = pack.checks.issue;
  if (issue) {
    const tracker = issue.tracker === "off" ? "none" : (issue.tracker ?? "either");
    byId.set("issue", { id: "issue", enabled: issue.enabled, values: { tracker } });
    if (issue.requireLabel || (issue.label ?? "").length > 0) {
      byId.set("issueLabel", { id: "issueLabel", enabled: issue.requireLabel === true, values: { label: issue.label ?? "" } });
    }
  }
  const drift = pack.checks.drift;
  if (drift) {
    byId.set("drift", { id: "drift", enabled: drift.enabled, values: { maxCommits: drift.maxBehindBy ?? 50 } });
  }
  const paths = pack.checks.paths;
  if (paths) {
    byId.set("paths", { id: "paths", enabled: paths.enabled, values: { globs: paths.forbiddenGlobs ?? [] } });
  }
  for (const id of DIRECT_IDS) {
    const row = pack.checks[id];
    if (row) byId.set(id, { id, enabled: row.enabled, values: {} });
  }
  return {
    repository: pack.repo,
    mode,
    checks: CHECK_CATALOG.flatMap((spec) => byId.get(spec.id) ?? []),
    custom: pack.custom.map((row) => ({
      id: row.id,
      enabled: true,
      custom: true,
      name: row.name,
      group: fromPackGroup(row.group),
      instruction: row.instruction,
      values: { instruction: row.instruction },
    })),
  };
}

function defaultValues(spec: CatalogCheck | undefined): DraftCheck["values"] {
  return spec?.valueKey ? { [spec.valueKey]: spec.defaultValue ?? "" } : {};
}

export function specOf(id: string): CatalogCheck | undefined {
  return CHECK_CATALOG.find((spec) => spec.id === id);
}

/** Switching off a check the saved pack never had drops it again, so toggling back leaves nothing to save. */
export function withChecksEnabled(pack: DraftPack, saved: DraftPack, ids: string[], enabled: boolean): DraftPack {
  let checks = pack.checks;
  for (const id of ids) {
    const row = checks.find((item) => item.id === id);
    if (!enabled && row && !rowById(saved, id)) checks = checks.filter((item) => item.id !== id);
    else if (row) checks = checks.map((item) => (item.id === id ? { ...item, enabled } : item));
    else if (enabled) checks = [...checks, { id, enabled, values: defaultValues(specOf(id)) }];
  }
  return { ...pack, checks };
}

/** Setting a value on a check the saved pack does not have adds it switched off; setting it back to the default drops it again. */
export function withCheckValue(pack: DraftPack, saved: DraftPack, id: string, key: string, value: DraftCheck["values"][string]): DraftPack {
  const row = rowById(pack, id) ?? { id, enabled: false, values: defaultValues(specOf(id)) };
  const next = { ...row, values: { ...row.values, [key]: value } };
  const others = pack.checks.filter((item) => item.id !== id);
  const untouched = !rowById(saved, id) && !next.enabled && JSON.stringify(next.values) === JSON.stringify(defaultValues(specOf(id)));
  if (untouched) return { ...pack, checks: others };
  return { ...pack, checks: rowById(pack, id) ? pack.checks.map((item) => (item.id === id ? next : item)) : [...others, next] };
}

export function checkValue(pack: DraftPack, id: string): DraftCheck["values"][string] | undefined {
  const spec = specOf(id);
  if (!spec?.valueKey) return undefined;
  return rowById(pack, id)?.values[spec.valueKey] ?? spec.defaultValue;
}

export function isCheckOn(pack: DraftPack, id: string): boolean {
  return rowById(pack, id)?.enabled ?? false;
}

export function hasCheck(pack: DraftPack, id: string): boolean {
  return rowById(pack, id) !== undefined;
}

function customNumber(id: string): number {
  return Number(/^custom-(\d+)$/.exec(id)?.[1] ?? 0);
}

export function withCustomCheck(pack: DraftPack, check: { name: string; group: CheckGroupId; instruction: string }): DraftPack {
  const next = Math.max(0, ...pack.custom.map((row) => customNumber(row.id))) + 1;
  return {
    ...pack,
    custom: [...pack.custom, { id: `custom-${next}`, enabled: true, custom: true, ...check, values: { instruction: check.instruction } }],
  };
}

export function withCustomInstruction(pack: DraftPack, id: string, instruction: string): DraftPack {
  return { ...pack, custom: pack.custom.map((row) => (row.id === id ? { ...row, instruction, values: { instruction } } : row)) };
}

export function withoutCustomCheck(pack: DraftPack, id: string): DraftPack {
  return { ...pack, custom: pack.custom.filter((row) => row.id !== id) };
}
