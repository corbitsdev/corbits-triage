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

export const MACHINE_CHECK_IDS = ["draft", "size", "duplicate", "reviewers", "conflicts", "drift", "ci", "paths"] as const;
export type MachineCheckId = (typeof MACHINE_CHECK_IDS)[number];

export const QUALITY_CHECK_IDS = ["focused", "docs", "issue", "tests"] as const;
export type QualityCheckId = (typeof QUALITY_CHECK_IDS)[number];

export const ISSUE_TRACKERS = ["github", "linear", "either", "off"] as const;
export type IssueTracker = (typeof ISSUE_TRACKERS)[number];

export const CHECK_CATALOG: Record<CatalogId, { group: CheckPackGroup; kind: "machine" | "quality" }> = {
  draft: { group: "pull-request", kind: "machine" },
  size: { group: "pull-request", kind: "machine" },
  duplicate: { group: "pull-request", kind: "machine" },
  focused: { group: "pull-request", kind: "quality" },
  docs: { group: "pull-request", kind: "quality" },
  issue: { group: "issue", kind: "quality" },
  reviewers: { group: "around", kind: "machine" },
  conflicts: { group: "around", kind: "machine" },
  drift: { group: "around", kind: "machine" },
  ci: { group: "code-vs-ci", kind: "machine" },
  tests: { group: "code-vs-ci", kind: "quality" },
  paths: { group: "code-vs-ci", kind: "machine" },
};

export const RECOMMENDED_SIZE = { maxFiles: 40, maxLines: 500 } as const;
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

export type CheckPack = {
  kind: typeof CHECK_PACK_KIND;
  schemaVersion: typeof CHECK_PACK_SCHEMA_VERSION;
  repo: string;
  checks: Partial<Record<CatalogId, CatalogCheck>>;
  custom: CustomCheck[];
};

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

export function checkPackName(repo: string): string {
  const clean = asRepo(repo);
  if (!clean) throw new Error("Repository must be owner/name.");
  return `check-pack/${clean}`;
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
      reviewers: { enabled: true },
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
  return { ...rec, custom: pack.custom };
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

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function parseCheckPack(raw: unknown, expectedRepo?: string): CheckPack | null {
  const body = asRecord(parseJson(raw));
  if (!body) return null;
  if (body.kind !== CHECK_PACK_KIND) return null;
  if (body.schemaVersion !== CHECK_PACK_SCHEMA_VERSION) return null;
  const repo = asRepo(body.repo);
  if (!repo) return null;
  if (expectedRepo !== undefined) {
    const expected = asRepo(expectedRepo);
    if (!expected || expected !== repo) return null;
  }
  const checksRaw = body.checks === undefined ? {} : asRecord(body.checks);
  if (!checksRaw) return null;
  const checks: CheckPack["checks"] = {};
  for (const [id, value] of Object.entries(checksRaw)) {
    if (!CATALOG_SET.has(id)) continue;
    const parsed = parseCatalogCheck(id as CatalogId, value);
    if (parsed) checks[id as CatalogId] = parsed;
  }
  return {
    kind: CHECK_PACK_KIND,
    schemaVersion: CHECK_PACK_SCHEMA_VERSION,
    repo,
    checks,
    custom: parseCustom(body.custom),
  };
}

/** Custom instructions are handed to the classifier as plain text, never evaluated. */
export function classificationSources(pack: CheckPack): {
  quality: Array<{ id: QualityCheckId; group: CheckPackGroup }>;
  custom: Array<{ name: string; group: CheckPackGroup; instruction: string }>;
} {
  return {
    quality: QUALITY_CHECK_IDS.filter((id) => catalogCheckEnabled(pack, id)).map((id) => ({
      id,
      group: CHECK_CATALOG[id].group,
    })),
    custom: pack.custom.map(({ name, group, instruction }) => ({ name, group, instruction })),
  };
}
