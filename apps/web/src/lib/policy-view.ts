import { type AuthorMatch, type Step, type StepKind } from "@corbits/triage-contracts";

/** What a new step can do. A verdict with no steps does nothing, so `nothing` is shown only when stored. */
export const STEP_DOS = ["approve", "merge", "close", "comment", "request-changes", "request-review", "assign", "labels"] as const satisfies readonly StepKind[];

export const STEP_DO_NAMES: Record<StepKind, string> = {
  approve: "Approve",
  merge: "Merge",
  close: "Close",
  comment: "Comment",
  "request-changes": "Request changes",
  "request-review": "Request review from…",
  assign: "Assign to…",
  labels: "Add label…",
  nothing: "Do nothing",
};

export const FOR_NAMES = {
  anyone: "anyone",
  "first-timers": "first-timers",
  maintainers: "maintainers",
  external: "external contributors",
  bots: "bots",
  team: "a GitHub team…",
  users: "specific people…",
} as const;

export type ForChoice = keyof typeof FOR_NAMES;

/** The builder sets one author a step is for and keeps any other condition the step holds. */
export function stepFor(step: Step): AuthorMatch | undefined {
  return step.when?.author?.[0];
}

export function withStepFor(step: Step, match: AuthorMatch | undefined): Step {
  const { author: _was, ...rest } = step.when ?? {};
  const when = match === undefined ? rest : { ...rest, author: [match] };
  const { when: _old, ...bare } = step;
  return (Object.keys(when).length > 0 ? { ...bare, when } : bare) as Step;
}

export function forChoice(step: Step): ForChoice {
  const match = stepFor(step);
  if (match === undefined) return "anyone";
  if (typeof match === "string") return match;
  return "team" in match ? "team" : "users";
}

/** A team or people start empty, to be filled in. */
function audienceOf(choice: Exclude<ForChoice, "anyone">): AuthorMatch {
  switch (choice) {
    case "team":
      return { team: "" };
    case "users":
      return { users: [] };
    default:
      return choice;
  }
}

/** The step for `choice`; anyone is the default, so it is not stored. */
export function withFor(step: Step, choice: ForChoice): Step {
  return withStepFor(step, choice === "anyone" ? undefined : audienceOf(choice));
}

export function freshStep(step: Step, next: StepKind): Step {
  const audience = step.when === undefined ? {} : { when: step.when };
  switch (next) {
    case "comment":
      return { do: next, target: { body: "" }, ...audience };
    case "request-review":
      return { do: next, target: { to: "codeowners" }, ...audience };
    case "assign":
      return { do: next, target: { to: "users", users: [] }, ...audience };
    case "labels":
      return { do: next, target: { from: "list", labels: [] }, ...audience };
    default:
      return { do: next, ...audience };
  }
}
