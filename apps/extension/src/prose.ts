import { RECOMMENDED_ISSUE, type ActionKind, type CatalogCheck, type CatalogId, type CheckPack, type CustomCheck, type IssueTracker, type ModelShape } from "@corbits/triage-contracts";
import type { SuggestedDo } from "@corbits/triage-workflows/logic/actions";

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

export type CheckKind = { shape: ModelShape; title: string; line: string };

export const CHECK_KINDS: CheckKind[] = [
  { shape: "is-true", title: "Is it true that…", line: "Fails when the answer is no." },
  { shape: "score", title: "Score", line: "Picks one of its levels; fails only below the level you pick." },
  { shape: "choose", title: "Which of these is it", line: "Fails on the answers you pick." },
];

export function customSentence(check: CustomCheck): string {
  switch (check.shape) {
    case "is-true": return `Is it true that ${check.claim}?`;
    case "score": return `Score ${check.subject} as ${check.levels.join(", ")}${check.failBelow ? `, fail below ${check.failBelow}` : ""}.`;
    case "choose": return `Which of ${check.options.join(", ")} is it? Fail on ${check.failOn.join(", ")}.`;
  }
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

export function doLabel(step: SuggestedDo, repo: string): string | null {
  const target = step.target as Target;
  return "unresolved" in target ? null : DO_LABELS[step.kind](target, repo);
}

export function commentBody(step: SuggestedDo): string | undefined {
  const body = (step.target as { body?: unknown }).body;
  return step.kind === "comment" && typeof body === "string" ? body : undefined;
}
