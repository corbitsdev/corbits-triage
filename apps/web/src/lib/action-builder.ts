import {
  type AuthorKind,
  type AuthorWho,
  customRuleId,
  readCheckPack,
  type ActionKind,
  type CheckPack,
  type CheckPackGroup,
  type CustomCheck,
  type CustomScope,
  type Do,
  type LabelsTarget,
  type ModelShape,
  type PeopleTarget,
  type RuleKind,
} from "@corbits/triage-contracts";
import { errorText } from "@corbits/common";
import type { CheckKind } from "./pack-prose.ts";

/** A Do as the editor holds it: every target field, so switching kind or recipient keeps what was typed. */
export type DoForm = {
  kind: ActionKind;
  from?: LabelsTarget["from"];
  labels?: string[];
  to?: PeopleTarget["to"];
  users?: string[];
  teams?: string[];
  role?: string;
  body?: string;
  prompt?: string;
  tools?: string[];
};

type CheckParams = {
  globs?: string[];
  changed?: string[];
  requires?: string[];
  pattern?: string;
  label?: string;
  count?: number;
  claim?: string;
  scope?: CustomScope;
  when?: string[];
  subject?: string;
  min?: number;
  options?: string[];
  failOn?: string[];
  who?: AuthorWho;
  users?: string[];
  role?: string;
  kinds?: AuthorKind[];
};

export type CheckForm = { name: string; group: CheckPackGroup; enabled?: boolean } & (
  | { kind: "rule"; rule: RuleKind }
  | { kind: "model"; shape: ModelShape }
) &
  CheckParams;

export type Refusal = { reason: string };

const PARAMS: Record<RuleKind | ModelShape, readonly (keyof CheckParams)[]> = {
  "paths-unchanged": ["globs"],
  "paths-together": ["changed", "requires"],
  "title-pattern": ["pattern"],
  "branch-pattern": ["pattern"],
  "label-required": ["label"],
  "diff-excludes": ["pattern"],
  "min-approvals": ["count"],
  author: ["who", "users", "role", "kinds"],
  "is-true": ["claim", "scope", "when"],
  score: ["subject", "min"],
  choose: ["options", "failOn"],
};

function peopleTarget(form: DoForm): Record<string, unknown> {
  switch (form.to) {
    case "users":
      return { to: form.to, users: form.users };
    case "teams":
      return { to: form.to, teams: form.teams };
    case "role":
      return { to: form.to, role: form.role };
    default:
      return { to: form.to };
  }
}

function doTarget(form: DoForm): Record<string, unknown> {
  switch (form.kind) {
    case "labels":
      return form.from === "list" ? { from: form.from, labels: form.labels } : { from: form.from };
    case "assign":
    case "request-review":
      return peopleTarget(form);
    case "comment":
      return { body: form.body };
    case "approve":
    case "request-changes":
    case "close":
      return {};
    case "agent":
      return { prompt: form.prompt, tools: form.tools ?? [] };
  }
}

/** The form as a stored Do, not yet validated: the draft holds it as typed and the save bar says what is wrong. */
export function buildDo(form: DoForm): Do {
  return { kind: form.kind, target: doTarget(form) } as Do;
}

function validated(candidate: unknown, repo: string): CheckPack | Refusal {
  try {
    return readCheckPack(candidate, repo);
  } catch (cause) {
    return { reason: errorText(cause) };
  }
}

function placed<T extends { id: string }>(rows: T[], row: T): T[] {
  return rows.some((item) => item.id === row.id) ? rows.map((item) => (item.id === row.id ? row : item)) : [...rows, row];
}

export function nextCustomId(pack: CheckPack, name: string): string {
  return customRuleId(name, pack.custom.map((row) => row.id));
}

/**
 * The form as a stored row, keeping only its rule's or shape's parameters and not yet validated:
 * the draft holds it as typed and the save bar says what is wrong.
 */
export function customCheckOf(form: CheckForm, id: string): CustomCheck {
  const variant = form.kind === "rule" ? { kind: form.kind, rule: form.rule } : { kind: form.kind, shape: form.shape };
  const params = PARAMS[form.kind === "rule" ? form.rule : form.shape].map((key) => [key, form[key]]);
  return { id, name: form.name, group: form.group, ...(form.enabled === false && { enabled: false }), ...variant, ...Object.fromEntries(params) } as CustomCheck;
}

/** A fresh form for a kind from the gallery, named after it. */
export function checkFormOfKind(kind: CheckKind): CheckForm {
  const name = kind.title.replace(/…$/, "");
  return kind.evaluation === "rule"
    ? { name, group: "pull-request", kind: "rule", rule: kind.rule, ...(kind.rule === "author" ? { who: "kinds" as const } : {}) }
    : { name, group: "pull-request", kind: "model", shape: kind.shape };
}

/** Builds the next custom check of `pack`, or replaces check `id` in place, keeping only its rule's or shape's parameters. */
export function buildCustomCheck(form: CheckForm, pack: CheckPack, id = nextCustomId(pack, form.name)): CustomCheck | Refusal {
  const check = customCheckOf(form, id);
  const read = validated({ ...pack, custom: placed<{ id: string }>(pack.custom, check) }, pack.repo);
  if ("reason" in read) return read;
  return read.custom.find((row) => row.id === id)!;
}

/** The editor's view of a stored Do, so editing it and building again gives the same Do back. */
export function doFormOf(step: Do): DoForm {
  return { kind: step.kind, ...step.target };
}

/** The editor's view of a stored custom check. */
export function checkFormOf(check: CustomCheck): CheckForm {
  const { id: _id, ...form } = check;
  return form;
}
