import {
  CATALOG_IDS,
  CHECK_CATALOG,
  TRIAGE_EVENTS,
  type Action,
  type ActionKind,
  type CatalogId,
  type CheckPack,
  type CheckRef,
  type Do,
  type ModelShape,
  type PeopleTarget,
  type RuleKind,
} from "@corbits/triage-contracts";
import type { ActionEvent } from "./action-builder.ts";

export type Evaluation = "rule" | "model";

export const ACTION_EVENTS = TRIAGE_EVENTS.filter((event): event is ActionEvent => event !== "catch-up");

export const EVENT_NAMES: Record<ActionEvent, string> = {
  opened: "opened",
  updated: "updated",
  ready: "ready for review",
  drafted: "converted to draft",
  commented: "commented on",
  reviewed: "reviewed",
  approved: "approved",
  "changes-requested": "changes requested",
  checks: "checks finished",
  closed: "closed",
  merged: "merged",
};

export const DO_NAMES: Record<ActionKind, string> = {
  labels: "Add labels",
  assign: "Assign",
  "request-review": "Request review",
  comment: "Comment",
  close: "Close",
  agent: "Run an agent",
};

export type Branch = "yes" | "no" | "unsure" | "always";

export const BRANCH_NAMES: Record<Branch, string> = { yes: "Yes", no: "No", unsure: "Unsure", always: "Always" };

/** The Do kinds the contract refuses to run automatically on a branch. */
export const MANUAL_ONLY: Record<Branch, readonly ActionKind[]> = { yes: [], no: [], unsure: ["close"], always: ["close", "agent"] };

export const CHECK_KINDS: Array<{ evaluation: "rule"; rule: RuleKind; title: string; line: string } | { evaluation: "model"; shape: ModelShape; title: string; line: string }> = [
  { evaluation: "rule", rule: "paths-unchanged", title: "Paths must not change", line: "Fails when any listed path is touched." },
  { evaluation: "rule", rule: "paths-together", title: "Paths must change together", line: "When one set of paths changes, another must too." },
  { evaluation: "rule", rule: "title-pattern", title: "Title matches a pattern", line: "The title must match a regular expression." },
  { evaluation: "rule", rule: "branch-pattern", title: "Branch matches a pattern", line: "The head branch must match a regular expression." },
  { evaluation: "rule", rule: "label-required", title: "Label required", line: "A label must be on the pull request." },
  { evaluation: "rule", rule: "diff-excludes", title: "Diff must not contain", line: "Added lines must not match a regular expression." },
  { evaluation: "rule", rule: "min-approvals", title: "Minimum approvals", line: "At least this many approvals." },
  { evaluation: "model", shape: "is-true", title: "Is it true that…", line: "Fails when the answer is no." },
  { evaluation: "model", shape: "score", title: "Score from 0 to 10", line: "Fails below the minimum." },
  { evaluation: "model", shape: "choose", title: "Which of these is it", line: "Fails on the answers you pick." },
];

export function isCatalogId(id: string): id is CatalogId {
  return (CATALOG_IDS as readonly string[]).includes(id);
}

export function checkName(pack: CheckPack, id: CheckRef): string {
  return isCatalogId(id) ? CHECK_CATALOG[id].name : pack.custom.find((row) => row.id === id)?.name ?? id;
}

export function evaluationOf(pack: CheckPack, id: CheckRef): Evaluation {
  if (isCatalogId(id)) return CHECK_CATALOG[id].kind === "machine" ? "rule" : "model";
  return pack.custom.find((row) => row.id === id)?.kind ?? "rule";
}

export function listed(words: string[], joiner: "and" | "or"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${joiner} ${words.at(-1)}`;
}

export function whenText(when: Action["when"]): string {
  if (when === "every") return "On every event";
  return `When ${listed(when.filter((event): event is ActionEvent => event !== "catch-up").map((event) => EVENT_NAMES[event]), "or")}`;
}

function quoted(text: string): string {
  return `“${text}”`;
}

function people(target: PeopleTarget): string {
  switch (target.to) {
    case "users":
      return listed(target.users.map((user) => `@${user}`), "and");
    case "teams":
      return listed(target.teams, "and");
    case "role":
      return `role ${target.role}`;
    case "codeowners":
      return "CODEOWNERS";
    case "author":
      return "the author";
  }
}

export function doText(step: Do): string {
  const text = doAction(step);
  return step.automatic ? `${text} automatically` : text;
}

function doAction(step: Do): string {
  switch (step.kind) {
    case "labels":
      if (step.target.from === "type") return "label it by type";
      if (step.target.from === "paths") return "label it by paths";
      return `add ${step.target.labels.length === 1 ? "the label" : "the labels"} ${listed(step.target.labels, "and")}`;
    case "assign":
      return `assign ${people(step.target)}`;
    case "request-review":
      return `request review from ${people(step.target)}`;
    case "comment":
      return `comment ${quoted(step.target.body)}`;
    case "close":
      return "close it";
    case "agent":
      return `ask an agent ${quoted(step.target.prompt)}`;
  }
}

/**
 * A contract or draft message as the panel shows it: actions by their place in the list, custom checks by name.
 * An id the pack does not hold yet is the action or check being built.
 */
export function shownReason(reason: string, pack: CheckPack): string {
  function action(_: string, id: string): string {
    const index = pack.actions.findIndex((row) => row.id === id);
    return index < 0 ? "This action" : `Action ${index + 1}`;
  }
  function namedCheck(_: string, id: string): string {
    const check = pack.custom.find((row) => row.id === id);
    return check ? `Check ${quoted(check.name)}` : "This check";
  }
  function check(id: string): string {
    const found = pack.custom.find((row) => row.id === id);
    return found ? quoted(found.name) : id;
  }
  return reason.replace(/\bAction (action-\d+)\b/g, action).replace(/\bCustom check (custom-\d+)\b/g, namedCheck).replace(/\bcustom-\d+\b/g, check);
}
