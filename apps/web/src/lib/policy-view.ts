import { AUTHOR_GROUPS, type AuthorGroup, type AuthorKind, type AuthorMatch, type Step } from "@corbits/triage-contracts";

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

type ForChoice = keyof typeof FOR_NAMES;

/** The first author a step is for. */
export function stepFor(step: Step): AuthorMatch | undefined {
  return step.when?.author?.[0];
}

function isGroup(author: readonly AuthorMatch[], kinds: readonly AuthorKind[]): boolean {
  return author.every((match) => typeof match === "string" && kinds.includes(match)) && kinds.every((kind) => author.includes(kind));
}

function startsWithGroup(author: readonly AuthorMatch[], kinds: readonly AuthorKind[]): boolean {
  return kinds.every((kind, index) => author[index] === kind);
}

/** Whom a step is for, as one choice: a step for several authors shows its first, as a group when the list starts with one. */
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
