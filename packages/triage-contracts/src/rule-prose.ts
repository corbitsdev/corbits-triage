// Plain-text words for a policy's rules.
import { CONVENTIONAL_FIELDS, DEFAULT_RISK, RECOMMENDED_ISSUE, type CatalogCheck, type CatalogId, type CheckPack, type CustomCheck, type IssueTracker, type TextCheck, type TextField, type TextMatch } from "./check-pack.js";

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
  "regression-risk": (row) => `Flag changes to files with ${row?.hotFileFixes ?? DEFAULT_RISK.hotFileFixes}+ fixes in the last ${DEFAULT_RISK.hotFileDays} days, or to migrations`,
  focused: () => "Check the change is focused on one thing",
  docs: () => "Check docs are updated when behavior changes",
  "ticket-goals": () => "Check the change matches its linked issue",
};

export function catalogSentence(id: CatalogId, pack: CheckPack): string {
  return CATALOG_SENTENCES[id](pack.checks[id]);
}

const TEXT_FIELD_NAMES: Record<TextField, string> = { title: "the title", description: "the description", commits: "any commit message" };

const TEXT_MATCH_NAMES: Record<TextMatch, string> = { contains: "contains", "not-contains": "does not contain" };

/** "the title, the description or any commit message" */
function textFieldsPhrase(fields: readonly TextField[]): string {
  const names = fields.map((field) => TEXT_FIELD_NAMES[field]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0]!;
}

function textSentence(check: TextCheck): string {
  return `Fail when ${textFieldsPhrase(check.fields)} ${TEXT_MATCH_NAMES[check.failWhen]} ${check.phrases.map((phrase) => `"${phrase}"`).join(", ")}`.trim();
}

export function customSentence(check: CustomCheck): string {
  if (check.kind === "text") return textSentence(check);
  if (check.kind === "code-patterns") return `Fail when added code matches ${[...check.presets.map((preset) => `the ${preset} preset`), ...check.patterns.map((pattern) => pattern.id)].join(", ")}`;
  switch (check.shape) {
    case "is-true":
      return `Is it true that ${check.claim}?`;
    case "score":
      return `Score ${check.subject} as ${check.levels.join(", ")}${check.failBelow ? `, fail below ${check.failBelow}` : ""}.`;
    case "choose":
      return `Which of ${check.options.join(", ")} is it? Fail on ${check.failOn.join(", ")}.`;
  }
}
