import {
  BUILT_IN_CHECK_NAMES,
  CHECK_CATALOG,
  checkName,
  isCatalogId,
  type ActionKind,
  type CheckPack,
  type CheckRef,
  type ModelShape,
  type PolicyEvent,
  type RuleKind,
  type VerdictWord,
} from "@corbits/triage-contracts";

export type Evaluation = "rule" | "model";

export const EVENT_NAMES: Record<PolicyEvent, string> = {
  opened: "opened",
  updated: "updated",
  checks: "checks finished",
  ready: "ready for review",
};

export const DO_NAMES: Record<ActionKind, string> = {
  labels: "Add labels",
  assign: "Assign",
  "request-review": "Request review",
  comment: "Comment",
  approve: "Approve",
  "request-changes": "Request changes on the pull request",
  close: "Close",
  agent: "Run an agent",
};

export type CheckKind = { evaluation: "rule"; rule: RuleKind; title: string; line: string } | { evaluation: "model"; shape: ModelShape; title: string; line: string };

export const CHECK_KINDS: CheckKind[] = [
  { evaluation: "rule", rule: "paths-unchanged", title: "Paths must not change", line: "Fails when any listed path is touched." },
  { evaluation: "rule", rule: "paths-together", title: "Paths must change together", line: "When one set of paths changes, another must too." },
  { evaluation: "rule", rule: "title-pattern", title: "Title matches a pattern", line: "The title must match a regular expression." },
  { evaluation: "rule", rule: "branch-pattern", title: "Branch matches a pattern", line: "The head branch must match a regular expression." },
  { evaluation: "rule", rule: "label-required", title: "Label required", line: "A label must be on the pull request." },
  { evaluation: "rule", rule: "diff-excludes", title: "Diff must not contain", line: "Added lines must not match a regular expression." },
  { evaluation: "rule", rule: "min-approvals", title: "Minimum approvals", line: "At least this many approvals." },
  { evaluation: "rule", rule: "author", title: "Author is", line: "Who opened it: named people, a role, or a kind of contributor. Informs the verdict; never fails it or asks anything of the author." },
  { evaluation: "model", shape: "is-true", title: "Is it true that…", line: "Fails when the answer is no." },
  { evaluation: "model", shape: "score", title: "Score from 0 to 10", line: "Fails below the minimum." },
  { evaluation: "model", shape: "choose", title: "Which of these is it", line: "Fails on the answers you pick." },
];

/** A check's name; a custom check's waits for its pack. */
export function checkLabel(pack: CheckPack | null, id: string): string | null {
  if (pack) return checkName(pack, id);
  const builtIn = BUILT_IN_CHECK_NAMES.get(id);
  if (builtIn !== undefined) return builtIn;
  return isCatalogId(id) ? CHECK_CATALOG[id].name : null;
}

export function evaluationOf(pack: CheckPack, id: CheckRef): Evaluation {
  if (isCatalogId(id)) return CHECK_CATALOG[id].kind === "machine" ? "rule" : "model";
  return pack.custom.find((row) => row.id === id)?.kind ?? "rule";
}

export function listed(words: string[], joiner: "and" | "or"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${joiner} ${words.at(-1)}`;
}

/** Ends with a full stop unless a quoted comment already ends the sentence. */
export function sentence(text: string): string {
  return /[.!?]”$/.test(text) ? text : `${text}.`;
}

export function quoted(text: string): string {
  return `“${text}”`;
}

export const LIST_NAMES: Record<VerdictWord, string> = { pass: "On Pass", fail: "On Fail", unsure: "On Unsure" };

/**
 * A contract or draft message as the panel shows it, verdict lists and custom rules by name; an id the policy does
 * not hold yet is the rule being built.
 */
export function shownReason(reason: string, pack: CheckPack): string {
  function namedRule(_: string, id: string): string {
    const rule = pack.custom.find((row) => row.id === id);
    return rule ? `Rule ${quoted(rule.name)}` : "This rule";
  }
  function list(_: string, word: VerdictWord): string {
    return LIST_NAMES[word];
  }
  return reason.replace(/^Actions when\b/, "When").replace(/^Actions (pass|fail|unsure)\b/, list).replace(/\bCustom rule ([a-z0-9]+(?:-[a-z0-9]+)*)\b/g, namedRule);
}
