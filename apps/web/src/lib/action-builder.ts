import {
  customRuleId,
  DEFAULT_SCORE_LEVELS,
  type CheckPack,
  type CheckPackGroup,
  type CustomCheck,
  type CustomScope,
  type LabelsTarget,
  type ModelShape,
  type PeopleTarget,
  type Step,
  type StepFor,
  type StepKind,
} from "@corbits/triage-contracts";
import type { CheckKind } from "./pack-prose.ts";

/** A step as the editor holds it: every target field, so switching kind or recipient keeps what was typed. */
export type DoForm = {
  kind: StepKind;
  for?: StepFor;
  from?: LabelsTarget["from"];
  labels?: string[];
  to?: PeopleTarget["to"];
  users?: string[];
  teams?: string[];
  body?: string;
};

type CheckParams = {
  claim?: string;
  scope?: CustomScope;
  when?: string[];
  subject?: string;
  levels?: string[];
  failBelow?: string;
  options?: string[];
  failOn?: string[];
};

export type CheckForm = { name: string; group: CheckPackGroup; enabled?: boolean; kind: "model"; shape: ModelShape } & CheckParams;

const PARAMS: Record<ModelShape, readonly (keyof CheckParams)[]> = {
  "is-true": ["claim", "scope", "when"],
  score: ["subject", "levels", "failBelow"],
  choose: ["options", "failOn"],
};

function peopleTarget(form: DoForm): Record<string, unknown> {
  switch (form.to) {
    case "users":
      return { to: form.to, users: form.users };
    case "teams":
      return { to: form.to, teams: form.teams };
    default:
      return { to: form.to };
  }
}

function doTarget(form: DoForm): Record<string, unknown> | undefined {
  switch (form.kind) {
    case "labels":
      return form.from === "list" ? { from: form.from, labels: form.labels } : { from: form.from };
    case "assign":
    case "request-review":
      return peopleTarget(form);
    case "comment":
      return { body: form.body };
    case "approve":
    case "merge":
    case "request-changes":
    case "close":
    case "nothing":
      return undefined;
  }
}

/** The form as a stored step, not yet validated: the draft holds it as typed and the save bar says what is wrong. */
export function buildDo(form: DoForm): Step {
  const target = doTarget(form);
  return { do: form.kind, ...(target && { target }), ...(form.for !== undefined && { for: form.for }) } as Step;
}

export function nextCustomId(pack: CheckPack, name: string): string {
  return customRuleId(name, pack.custom.map((row) => row.id));
}

/**
 * The form as a stored row, keeping only its shape's parameters and not yet validated:
 * the draft holds it as typed and the save bar says what is wrong.
 */
export function customCheckOf(form: CheckForm, id: string): CustomCheck {
  const params = PARAMS[form.shape].map((key) => [key, form[key]]);
  return { id, name: form.name, group: form.group, ...(form.enabled === false && { enabled: false }), kind: "model", shape: form.shape, ...Object.fromEntries(params) } as CustomCheck;
}

/** A fresh form for a kind from the gallery, named after it. */
export function checkFormOfKind(kind: CheckKind): CheckForm {
  const name = kind.title.replace(/…$/, "");
  return { name, group: "pull-request", kind: "model", shape: kind.shape, ...(kind.shape === "score" && { levels: [...DEFAULT_SCORE_LEVELS] }) };
}

/** The editor's view of a stored step, so editing it and building again gives the same step back. */
export function doFormOf(step: Step): DoForm {
  return { kind: step.do, ...("target" in step && step.target), ...(step.for !== undefined && { for: step.for }) };
}

/** The editor's view of a stored custom check. */
export function checkFormOf(check: CustomCheck): CheckForm {
  const { id: _id, ...form } = check;
  return form;
}
