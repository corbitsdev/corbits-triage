import { RECOMMENDED_ISSUE, type ActionKind, type CatalogCheck, type CatalogId, type CheckPack, type CustomCheck, type IssueTracker, type ModelShape, type RuleKind } from "@corbits/triage-contracts";
import { DEBUG_LEFTOVERS, SOURCE_GLOBS, TEST_GLOBS } from "./local-pack.ts";
import type { SuggestedDo } from "@corbits/triage-workflows/logic/actions";

/** Each built-in rule in the portal's words, in the order its rules panel lists them; limits read from the policy. */
const CATALOG_SENTENCES: Record<CatalogId, (row: CatalogCheck | undefined) => string> = {
  "max-files-changed": (row) => `Flag pull requests over ${count(row?.maxFiles)} files changed`,
  "max-lines-changed": (row) => `Flag pull requests over ${count(row?.maxLines)} lines changed`,
  "linked-issue": (row) => `Require a linked issue from ${ISSUE_TRACKER_NAMES[row?.tracker && row.tracker !== "off" ? row.tracker : RECOMMENDED_ISSUE.tracker]}`,
  "no-merge-conflicts": () => "Flag merge conflicts with the base branch",
  "ci-green": () => "CI must pass before merge",
  "no-forbidden-paths": (row) => `Never accept changes to ${(row?.forbiddenGlobs ?? []).join(", ") || "forbidden paths"}`,
  focused: () => "Check the change is focused on one thing",
  docs: () => "Check docs are updated when behavior changes",
};

export const CATALOG_ORDER = Object.keys(CATALOG_SENTENCES) as CatalogId[];

function count(value: number | undefined): string {
  return value?.toLocaleString() ?? "any number of";
}

export function catalogSentence(id: CatalogId, pack: CheckPack): string {
  return CATALOG_SENTENCES[id](pack.checks[id]);
}

export const ISSUE_TRACKER_NAMES: Record<IssueTracker, string> = { github: "GitHub", linear: "Linear", either: "GitHub or Linear", off: "Not required" };

/** A kind of check a person can add, as the portal's new-check gallery names it. */
export type CheckKind = ({ evaluation: "rule"; rule: RuleKind } | { evaluation: "model"; shape: ModelShape }) & { title: string; line: string };

/** The portal's gallery. */
export const CHECK_KINDS: CheckKind[] = [
  { evaluation: "rule", rule: "paths-unchanged", title: "Paths must not change", line: "Fails when any listed path is touched." },
  { evaluation: "rule", rule: "paths-together", title: "Paths must change together", line: "When one set of paths changes, another must too." },
  { evaluation: "rule", rule: "title-pattern", title: "Title matches a pattern", line: "The title must match a regular expression." },
  { evaluation: "rule", rule: "branch-pattern", title: "Branch matches a pattern", line: "The head branch must match a regular expression." },
  { evaluation: "rule", rule: "label-required", title: "Label required", line: "A label must be on the pull request." },
  { evaluation: "rule", rule: "diff-excludes", title: "Diff must not contain", line: "Added lines must not match a regular expression." },
  { evaluation: "rule", rule: "min-approvals", title: "Minimum approvals", line: "At least this many approvals." },
  { evaluation: "model", shape: "is-true", title: "Is it true that…", line: "Fails when the answer is no." },
  { evaluation: "model", shape: "score", title: "Score", line: "Picks one of its levels; fails only below the level you pick." },
  { evaluation: "model", shape: "choose", title: "Which of these is it", line: "Fails on the answers you pick." },
];

/** A custom check as the portal's sentence for its rule or shape reads, with its values in place. */
export function customSentence(check: CustomCheck): string {
  if (check.kind === "model") {
    switch (check.shape) {
      case "is-true": return `Is it true that ${check.claim}?`;
      case "score": return `Score ${check.subject} as ${check.levels.join(", ")}${check.failBelow ? `, fail below ${check.failBelow}` : ""}.`;
      case "choose": return `Which of ${check.options.join(", ")} is it? Fail on ${check.failOn.join(", ")}.`;
    }
  }
  switch (check.rule) {
    case "paths-unchanged": return `Fail if any of ${listed(check.globs)} changes.`;
    case "paths-together":
      if (sameList(check.changed, SOURCE_GLOBS) && sameList(check.requires, TEST_GLOBS)) return "When source files change, test files must change too.";
      return `When ${listed(check.changed)} changes, ${listed(check.requires)} must change too.`;
    case "title-pattern": return `Title must match ${check.pattern}`;
    case "branch-pattern": return `Branch must match ${check.pattern}`;
    case "label-required": return `Require the label ${check.label}`;
    case "diff-excludes":
      if (check.pattern === DEBUG_LEFTOVERS) return "Added lines must not leave a debugger, a focused test or a console.log behind";
      return `Added lines must not match ${check.pattern}`;
    case "min-approvals": return `Require at least ${check.count} approvals`;
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** A long glob list reads as its first few and a count. */
function listed(globs: string[]): string {
  return globs.length > 3 ? `${globs.slice(0, 3).join(", ")} or ${globs.length - 3} more` : globs.join(", ");
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

type Target = Record<string, unknown>;

/** What each Do kind does, in full: the action and what it acts on. Null when its target names nothing to act on. */
const DO_LABELS: Record<ActionKind, (target: Target, repo: string) => string | null> = {
  labels(target) {
    const labels = strings(target.labels);
    return labels.length ? `Add ${labels.length === 1 ? "label" : "labels"} ${labels.join(", ")}` : null;
  },
  assign(target) {
    const users = strings(target.users);
    return users.length ? `Assign this pull request to ${users.map((user) => `@${user}`).join(", ")}` : null;
  },
  "request-review"(target, repo) {
    const owner = repo.split("/", 1)[0];
    const reviewers = [...strings(target.teams).map((team) => `@${owner}/${team}`), ...strings(target.users).map((user) => `@${user}`)];
    return reviewers.length ? `Request review from ${reviewers.join(", ")}` : null;
  },
  comment(target) {
    return typeof target.body === "string" && target.body.trim() ? "Comment on this pull request" : null;
  },
  approve() {
    return "Approve this pull request";
  },
  "request-changes"() {
    return "Request changes on this pull request";
  },
  close() {
    return "Close this pull request";
  },
  merge() {
    return "Merge this pull request";
  },
};

/** What running a Do would do, or null for one whose target is still unresolved or names nothing. */
export function doLabel(step: SuggestedDo, repo: string): string | null {
  const target = step.target as Target;
  return "unresolved" in target ? null : DO_LABELS[step.kind](target, repo);
}

export function commentBody(step: SuggestedDo): string | undefined {
  const body = (step.target as { body?: unknown }).body;
  return step.kind === "comment" && typeof body === "string" ? body : undefined;
}
