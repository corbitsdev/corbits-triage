import {
  readCheckPack,
  type Action,
  type ActionKind,
  type CheckPack,
  type CheckPackGroup,
  type CheckRef,
  type CustomCheck,
  type LabelsTarget,
  type ModelShape,
  type PeopleTarget,
  type RuleKind,
  type TriageEvent,
} from "@corbits/triage-contracts";
import { errorText } from "./error-text.ts";

export type ActionEvent = Exclude<TriageEvent, "catch-up">;

/** A Do as the editor holds it: every target field, so switching kind or recipient keeps what was typed. */
export type DoForm = {
  kind: ActionKind;
  automatic: boolean;
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
  checks: CheckRef[];
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
  subject?: string;
  min?: number;
  options?: string[];
  failOn?: string[];
};

export type CheckForm = { name: string; group: CheckPackGroup } & (
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
  "is-true": ["claim"],
  score: ["subject", "min"],
  choose: ["options", "failOn"],
};

/** Highest plus one rather than lowest unused, so a gap left by a removed row is never refilled. */
function nextId(prefix: "action" | "custom", ids: string[]): string {
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
    case "close":
      return {};
    case "agent":
      return { prompt: form.prompt, tools: form.tools ?? [] };
  }
}

function buildDo(form: DoForm): Record<string, unknown> {
  return { kind: form.kind, automatic: form.automatic, target: doTarget(form) };
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

/** Builds the next action of `pack`; the reason is readCheckPack's, unchanged. */
export function buildAction(form: ActionForm, pack: CheckPack): Action | Refusal {
  const id = nextId("action", pack.actions.map((action) => action.id));
  const action = { id, when: form.when, checks: form.checks, branches: buildBranches(form) };
  const read = validated({ ...pack, actions: [...pack.actions, action] }, pack.repo);
  if ("reason" in read) return read;
  return read.actions.find((row) => row.id === id)!;
}

/** Builds the next custom check of `pack`, keeping only its rule's or shape's parameters. */
export function buildCustomCheck(form: CheckForm, pack: CheckPack): CustomCheck | Refusal {
  const id = nextId("custom", pack.custom.map((row) => row.id));
  const variant = form.kind === "rule" ? { kind: form.kind, rule: form.rule } : { kind: form.kind, shape: form.shape };
  const params = PARAMS[form.kind === "rule" ? form.rule : form.shape].map((key) => [key, form[key]]);
  const check = { id, name: form.name, group: form.group, ...variant, ...Object.fromEntries(params) };
  const read = validated({ ...pack, custom: [...pack.custom, check] }, pack.repo);
  if ("reason" in read) return read;
  return read.custom.find((row) => row.id === id)!;
}
