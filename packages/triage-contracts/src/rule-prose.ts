// Plain-text words for a policy's rules and Dos; only the browser extension uses them today.
import { CONVENTIONAL_FIELDS, RECOMMENDED_ISSUE, type ActionKind, type CatalogCheck, type CatalogId, type CheckPack, type CustomCheck, type IssueTracker, type ModelShape, type TextCheck, type TextField, type TextMatch } from "./check-pack.js";
import type { ResolvedTarget } from "./do.js";

export const ISSUE_TRACKER_NAMES: Record<IssueTracker, string> = { github: "GitHub", linear: "Linear", either: "GitHub or Linear", off: "Not required" };

function count(value: number | undefined): string {
  return value?.toLocaleString() ?? "any number of";
}

const CONVENTIONAL_SUBJECTS = { title: "a conventional commit title", commits: "conventional commit messages", both: "a conventional commit title and messages" } as const;

function conventionalSentence(row: CatalogCheck | undefined): string {
  const fields = row?.fields ?? CONVENTIONAL_FIELDS;
  const subject = CONVENTIONAL_SUBJECTS[fields.length === 1 ? fields[0]! : "both"];
  return `Require ${subject}${row?.types ? ` of type ${row.types.join(", ")}` : ""}`;
}

const CATALOG_SENTENCES: Record<CatalogId, (row: CatalogCheck | undefined) => string> = {
  "max-files-changed": (row) => `Flag pull requests over ${count(row?.maxFiles)} files changed`,
  "max-lines-changed": (row) => `Flag pull requests over ${count(row?.maxLines)} lines changed`,
  "max-lines-changed-per-file": (row) => `Flag pull requests over ${count(row?.maxFileLines)} lines changed in one file`,
  "max-additions": (row) => `Flag pull requests over ${count(row?.maxAdditions)} lines added`,
  "max-deletions": (row) => `Flag pull requests over ${count(row?.maxDeletions)} lines deleted`,
  "linked-issue": (row) => `Require a linked issue from ${ISSUE_TRACKER_NAMES[row?.tracker && row.tracker !== "off" ? row.tracker : RECOMMENDED_ISSUE.tracker]}`,
  "no-merge-conflicts": () => "Flag merge conflicts with the base branch",
  "ci-green": () => "CI must pass before merge",
  "no-forbidden-paths": (row) => `Never accept changes to ${(row?.forbiddenGlobs ?? []).join(", ") || "forbidden paths"}`,
  "conventional-commits": conventionalSentence,
  "hidden-content": () => "Flag pull requests that hide text",
  focused: () => "Check the change is focused on one thing",
  docs: () => "Check docs are updated when behavior changes",
};

export const CATALOG_ORDER = Object.keys(CATALOG_SENTENCES) as CatalogId[];

export function catalogSentence(id: CatalogId, pack: CheckPack): string {
  return CATALOG_SENTENCES[id](pack.checks[id]);
}

export type RuleKind = { shape: ModelShape; title: string; line: string };

export const RULE_KINDS: RuleKind[] = [
  { shape: "is-true", title: "Is it true that…", line: "Fails when the answer is no." },
  { shape: "score", title: "Score", line: "Picks one of its levels; fails only below the level you pick." },
  { shape: "choose", title: "Which of these is it", line: "Fails on the answers you pick." },
];

export const TEXT_FIELD_NAMES: Record<TextField, string> = { title: "the title", description: "the description", commits: "any commit message" };

export const TEXT_MATCH_NAMES: Record<TextMatch, string> = { contains: "contains", "not-contains": "does not contain" };

/** "the title, the description or any commit message" */
export function textFieldsPhrase(fields: readonly TextField[]): string {
  const names = fields.map((field) => TEXT_FIELD_NAMES[field]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0]!;
}

export function textSentence(check: TextCheck): string {
  return `Fail when ${textFieldsPhrase(check.fields)} ${TEXT_MATCH_NAMES[check.failWhen]} ${check.phrases.map((phrase) => `"${phrase}"`).join(", ")}`.trim();
}

export function customSentence(check: CustomCheck): string {
  if (check.kind === "text") return textSentence(check);
  switch (check.shape) {
    case "is-true":
      return `Is it true that ${check.claim}?`;
    case "score":
      return `Score ${check.subject} as ${check.levels.join(", ")}${check.failBelow ? `, fail below ${check.failBelow}` : ""}.`;
    case "choose":
      return `Which of ${check.options.join(", ")} is it? Fail on ${check.failOn.join(", ")}.`;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

type Target = Record<string, unknown>;

/** What each Do kind does, in full: the action and what it acts on. Null when its target names nothing to act on. */
const DO_SENTENCES: Record<ActionKind, (target: Target, repo: string) => string | null> = {
  labels(target) {
    const labels = strings(target.labels);
    if (labels.length === 0) return null;
    return `Add ${labels.length === 1 ? "label" : "labels"} ${labels.join(", ")}`;
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
  approve: () => "Approve this pull request",
  "request-changes": () => "Request changes on this pull request",
  close: () => "Close this pull request",
  merge: () => "Merge this pull request",
};

export function doSentence(kind: ActionKind, target: ResolvedTarget, repo: string): string | null {
  return "unresolved" in target ? null : DO_SENTENCES[kind](target, repo);
}
