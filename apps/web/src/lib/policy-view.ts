import { type Step, type StepFor, type StepKind } from "@corbits/triage-contracts";

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

export function forChoice(step: Step): ForChoice {
  if (step.for === undefined) return "anyone";
  if (typeof step.for === "string") return step.for;
  return "team" in step.for ? "team" : "users";
}

/** A team or people start empty, to be filled in. */
function audienceOf(choice: Exclude<ForChoice, "anyone">): StepFor {
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
  const { for: _was, ...rest } = step;
  if (choice === "anyone") return rest as Step;
  return { ...rest, for: audienceOf(choice) } as Step;
}

/** A step after its Do changes: keeps who it is for and starts the new Do's values empty. */
export function freshStep(step: Step, next: StepKind): Step {
  const audience = step.for === undefined ? {} : { for: step.for };
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
