// SPDX-License-Identifier: GPL-2.0-only
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
  { id: "pr", label: "Pull request", help: "How many files and lines, one purpose, duplicate of another pull request, draft." },
  { id: "issue", label: "Issue", help: "Whether a linked issue is required, where it lives, a label, and whether it matches the change." },
  { id: "around", label: "Around it", help: "Reviewers, approvals, base drift, merge conflicts." },
  { id: "code", label: "Code vs CI", help: "Required GitHub checks, tests in the diff, forbidden paths, contributor-written docs." },
] as const;

export type CheckGroupId = (typeof CHECK_GROUPS)[number]["id"];

export type CatalogCheck = {
  id: string;
  name: string;
  group: CheckGroupId;
  kind: "machine" | "quality";
  help: string;
  leftover?: "draft" | "ci" | "duplicate" | "conflicts" | "reviewers" | "drift";
  param?: "number" | "select" | "text" | "globs";
  valueKey?: string;
  defaultValue?: string | number | string[];
  suffix?: string;
  min?: number;
  options?: Array<{ value: string; label: string }>;
};

export const CHECK_CATALOG: CatalogCheck[] = [
  { id: "files", name: "PRs touch fewer than N files", group: "pr", kind: "machine", help: "Inspects how many files the pull request touches.", param: "number", valueKey: "maxFiles", defaultValue: 20, suffix: "files", min: 1 },
  { id: "size", name: "PRs change fewer than N lines", group: "pr", kind: "machine", help: "Inspects added and removed line count on the pull request.", param: "number", valueKey: "maxLines", defaultValue: 500, suffix: "lines", min: 1 },
  { id: "focused", name: "One focused change", group: "pr", kind: "quality", help: "Inspects the title, body, and diff for a single purpose." },
  { id: "duplicate", name: "Duplicate of an earlier open PR", group: "pr", kind: "machine", help: "Compares this pull request to earlier open pull requests in this repository.", leftover: "duplicate" },
  { id: "draft", name: "Draft", group: "pr", kind: "machine", help: "Inspects whether GitHub marks the pull request as a draft.", leftover: "draft" },
  { id: "issue", name: "PR must have an issue in", group: "issue", kind: "machine", help: "Inspects whether the pull request points at an issue in the tracker you set.", param: "select", valueKey: "tracker", defaultValue: "either", options: [
    { value: "github", label: "GitHub" },
    { value: "linear", label: "Linear" },
    { value: "either", label: "GitHub or Linear" },
    { value: "none", label: "Not required" },
  ] },
  { id: "issueLabel", name: "Issue must have a label", group: "issue", kind: "machine", help: "When on, the linked issue must carry this label.", param: "text", valueKey: "label", defaultValue: "" },
  { id: "issueMatch", name: "Linked issue matches the change", group: "issue", kind: "quality", help: "Inspects whether the linked issue title and body match the change." },
  { id: "reviewers", name: "Reviewers requested or approvals present", group: "around", kind: "machine", help: "Inspects requested reviewers and approvals around the pull request.", leftover: "reviewers" },
  { id: "drift", name: "Base drift fewer than N commits", group: "around", kind: "machine", help: "Inspects how far the branch is behind the base.", leftover: "drift", param: "number", valueKey: "maxCommits", defaultValue: 50, suffix: "commits", min: 0 },
  { id: "conflicts", name: "Merge conflicts", group: "around", kind: "machine", help: "Inspects mergeability against the base branch.", leftover: "conflicts" },
  { id: "ci", name: "Required GitHub checks pass", group: "code", kind: "machine", help: "Inspects required GitHub checks on the head.", leftover: "ci" },
  { id: "tests", name: "Tests for behaviour changes", group: "code", kind: "quality", help: "Inspects the diff for tests when behaviour changes." },
  { id: "paths", name: "Forbidden paths", group: "code", kind: "machine", help: "Inspects changed paths against these globs.", param: "globs", valueKey: "globs", defaultValue: ["vendor/**", "node_modules/**"] },
  { id: "docs", name: "Contributor-written docs", group: "code", kind: "quality", help: "Inspects documentation in the pull request." },
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

export function packJson(pack: DraftPack): string {
  try {
    return JSON.stringify(checkPackFromDraft(pack), null, 2);
  } catch {
    return JSON.stringify({
      kind: CHECK_PACK_KIND,
      schemaVersion: CHECK_PACK_SCHEMA_VERSION,
      repo: pack.repository,
      checks: {},
      custom: [],
    }, null, 2);
  }
}

export function leftoverFromPack(pack: DraftPack): Record<"draft" | "ci" | "duplicate" | "conflicts" | "reviewers" | "drift", boolean> {
  const enabled = new Set(pack.checks.filter((row) => row.enabled).map((row) => row.id));
  return {
    draft: enabled.has("draft"),
    ci: enabled.has("ci"),
    duplicate: enabled.has("duplicate"),
    conflicts: enabled.has("conflicts"),
    reviewers: enabled.has("reviewers"),
    drift: enabled.has("drift"),
  };
}
