import {
  type AuthorKind,
  type AuthorWho,
  customRuleId,
  readCheckPack,
  type Action,
  type ActionKind,
  type CheckPack,
  type CheckPackGroup,
  type ActionCheckRef,
  type CustomCheck,
  type CustomScope,
  type Do,
  type LabelsTarget,
  type ModelShape,
  type PeopleTarget,
  type RuleKind,
  type TriageEvent,
} from "@corbits/triage-contracts";
import { errorText } from "@corbits/common";
import type { CheckKind } from "./pack-prose.ts";

export type ActionEvent = Exclude<TriageEvent, "catch-up">;

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

/** `always` runs when there are no checks; otherwise only the yes, no and unsure lists that have Dos are kept. */
export type ActionForm = {
  when: "every" | ActionEvent[];
  checks: ActionCheckRef[];
  yes: DoForm[];
  no: DoForm[];
  unsure: DoForm[];
  always: DoForm[];
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

/** Highest plus one rather than lowest unused, so a gap left by a removed row is never refilled. */
function nextId(prefix: "action", ids: string[]): string {
  const numbered = new RegExp(`^${prefix}-(\\d+)$`);
  const taken = ids.flatMap((id) => {
    const match = numbered.exec(id);
    return match ? [Number(match[1])] : [];
  });
  return `${prefix}-${Math.max(0, ...taken) + 1}`;
}

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

function buildDo(form: DoForm): Record<string, unknown> {
  return { kind: form.kind, target: doTarget(form) };
}

function buildBranches(form: ActionForm): Record<string, unknown> {
  if (form.checks.length === 0) return { always: form.always.map(buildDo) };
  const branches: Record<string, unknown> = {};
  for (const key of ["yes", "no", "unsure"] as const) {
    if (form[key].length > 0) branches[key] = form[key].map(buildDo);
  }
  return branches;
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

/** Builds the next action of `pack`, or replaces action `id` in place; the reason is readCheckPack's, unchanged. */
export function buildAction(form: ActionForm, pack: CheckPack, id = nextId("action", pack.actions.map((action) => action.id))): Action | Refusal {
  const action = { id, when: form.when, checks: form.checks, branches: buildBranches(form) };
  const read = validated({ ...pack, actions: placed<{ id: string }>(pack.actions, action) }, pack.repo);
  if ("reason" in read) return read;
  return read.actions.find((row) => row.id === id)!;
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

function isActionEvent(event: TriageEvent): event is ActionEvent {
  return event !== "catch-up";
}

function doFormOf(step: Do): DoForm {
  return { kind: step.kind, ...step.target };
}

/** The editor's view of a stored action, so editing it and building again gives the same action back. */
export function actionFormOf(action: Action): ActionForm {
  const branches: Partial<Record<"yes" | "no" | "unsure" | "always", Do[]>> = action.branches;
  const dos = (key: keyof typeof branches) => (branches[key] ?? []).map(doFormOf);
  return { when: action.when === "every" ? "every" : action.when.filter(isActionEvent), checks: action.checks, yes: dos("yes"), no: dos("no"), unsure: dos("unsure"), always: dos("always") };
}

/** The editor's view of a stored custom check. */
export function checkFormOf(check: CustomCheck): CheckForm {
  const { id: _id, ...form } = check;
  return form;
}
