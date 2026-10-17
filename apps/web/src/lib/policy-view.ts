import { AUTHOR_GROUPS, type AuthorGroup, type AuthorKind, type AuthorMatch, type Step, type StepKind } from "@corbits/triage-contracts";

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
  OWNER: "owners",
  MEMBER: "organization members",
  COLLABORATOR: "collaborators",
  CONTRIBUTOR: "past contributors",
  FIRST_TIME_CONTRIBUTOR: "first-time contributors",
  FIRST_TIMER: "people new to GitHub",
  NONE: "outside authors",
  MANNEQUIN: "imported authors",
  team: "a GitHub team…",
  users: "specific people…",
} as const satisfies Record<"anyone" | AuthorGroup | Exclude<AuthorKind, "BOT"> | "team" | "users", string>;

export type ForChoice = keyof typeof FOR_NAMES;

/** The builder sets one author a step is for and keeps any other condition the step holds. */
export function stepFor(step: Step): AuthorMatch | undefined {
  return step.when?.author?.[0];
}

export function withStepFor(step: Step, author: AuthorMatch[] | undefined): Step {
  const { author: _was, ...rest } = step.when ?? {};
  const when = author === undefined ? rest : { ...rest, author };
  const { when: _old, ...bare } = step;
  return (Object.keys(when).length > 0 ? { ...bare, when } : bare) as Step;
}

function isGroup(author: readonly AuthorMatch[], kinds: readonly AuthorKind[]): boolean {
  return author.every((match) => typeof match === "string" && kinds.includes(match)) && kinds.every((kind) => author.includes(kind));
}

function startsWithGroup(author: readonly AuthorMatch[], kinds: readonly AuthorKind[]): boolean {
  return kinds.every((kind, index) => author[index] === kind);
}

/** The builder shows one choice; a step for several authors shows its first, as a group when the list starts with one. */
export function forChoice(step: Step): ForChoice {
  const author = step.when?.author;
  if (author === undefined) return "anyone";
  const groups = Object.keys(AUTHOR_GROUPS) as AuthorGroup[];
  const group = groups.find((name) => isGroup(author, AUTHOR_GROUPS[name])) ?? groups.find((name) => startsWithGroup(author, AUTHOR_GROUPS[name]));
  if (group) return group;
  const match = author[0]!;
  if (typeof match === "string") return match === "BOT" ? "bots" : match;
  return "team" in match ? "team" : "users";
}

/** A team or people start empty, to be filled in. */
function audienceOf(choice: Exclude<ForChoice, "anyone">): AuthorMatch[] {
  switch (choice) {
    case "team":
      return [{ team: "" }];
    case "users":
      return [{ users: [] }];
    case "first-timers":
    case "maintainers":
    case "external":
    case "bots":
      return [...AUTHOR_GROUPS[choice]];
    default:
      return [choice];
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
