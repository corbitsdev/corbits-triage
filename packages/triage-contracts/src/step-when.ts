import { AUTHOR_GROUPS, type AuthorKind, type AuthorMatch, type CiState, type FileGroup, type SizeBound, type StepWhen } from "./check-pack.js";

/** The group every author is in; it always matches. */
export const EVERYONE = "everyone";

/** `groups` is what `authorGroupsOf` answers for the author; without it, a step for a group other than `everyone` is not known to hold. */
export type StepAuthor = { login: string; kind?: AuthorKind; teams?: readonly string[]; teamsUnknown?: readonly string[]; groups?: readonly string[] };

/** Whether the author is in the group, or undefined when only teams that can't be read would say. */
function inGroup(group: FileGroup, author: StepAuthor): boolean | undefined {
  if (author.kind !== undefined && group.association?.includes(author.kind)) return true;
  if (group.users?.some((login) => login.toLowerCase() === author.login.toLowerCase())) return true;
  if (!group.teams) return false;
  if (group.teams.some((team) => author.teams?.includes(team))) return true;
  if (!author.teams || group.teams.some((team) => author.teamsUnknown?.includes(team))) return undefined;
  return false;
}

/**
 * The groups an author is in: the first of the file's groups they match, in the file's order, then each built-in group
 * their kind is in that no file group replaces by name, then `everyone`. Failing closed, it is undefined, so that no
 * group but `everyone` holds, when the author's kind is not known or teams that can't be read would decide their group.
 */
export function authorGroupsOf(groups: Readonly<Record<string, FileGroup>>, author: StepAuthor): string[] | undefined {
  const kind = author.kind;
  if (kind === undefined) return undefined;
  let own: string | undefined;
  for (const [name, group] of Object.entries(groups)) {
    const held = inGroup(group, author);
    if (held === undefined) return undefined;
    if (!held) continue;
    own = name;
    break;
  }
  const builtIn = Object.entries(AUTHOR_GROUPS).filter(([name, kinds]) => !Object.hasOwn(groups, name) && (kinds as readonly AuthorKind[]).includes(kind));
  return [...(own === undefined ? [] : [own]), ...builtIn.map(([name]) => name), EVERYONE];
}

/** What a step's conditions are read against. */
export type StepSubject = { author: StepAuthor; linkedIssue: boolean; ci: CiState; files: number; lines: number };

/** `matches` is undefined when what the condition reads is not known. */
export type Holds = { matches: boolean | undefined; reason: string };

function matchName(match: AuthorMatch): string {
  if (typeof match === "string") return match;
  if ("group" in match) return match.group;
  return "team" in match ? match.team : match.users.join(", ");
}

function authorMatches(match: AuthorMatch, author: StepAuthor): boolean | undefined {
  if (typeof match === "string") return author.kind === undefined ? undefined : match === author.kind;
  if ("group" in match) return match.group === EVERYONE || author.groups?.includes(match.group);
  if ("users" in match) return match.users.some((login) => login.toLowerCase() === author.login.toLowerCase());
  if (author.teams?.includes(match.team)) return true;
  if (!author.teams || author.teamsUnknown?.includes(match.team)) return undefined;
  return false;
}

function authorHolds(matches: readonly AuthorMatch[], author: StepAuthor): Holds {
  const names = [...new Set(matches.map(matchName))].join(" or ");
  const answers = matches.map((match) => authorMatches(match, author));
  if (answers.includes(true)) return { matches: true, reason: `the author is ${names}` };
  if (answers.includes(undefined)) return { matches: undefined, reason: `it is not known whether the author is ${names}` };
  return { matches: false, reason: author.kind === undefined ? `the author is not ${names}` : `the author is ${author.kind}, not ${names}` };
}

function boundHolds(bound: SizeBound, count: number, noun: string): Holds {
  const over = bound.over === undefined || count > bound.over;
  const atMost = bound.atMost === undefined || count <= bound.atMost;
  const limits = [bound.over !== undefined && `over ${bound.over}`, bound.atMost !== undefined && `at most ${bound.atMost}`].filter(Boolean).join(" and ");
  return { matches: over && atMost, reason: `it changes ${count} ${noun}, ${over && atMost ? "" : "not "}${limits}` };
}

function conditions(when: StepWhen, subject: StepSubject): Holds[] {
  const out: Holds[] = [];
  if (when.author) out.push(authorHolds(when.author, subject.author));
  if (when.linkedIssue !== undefined) {
    out.push({ matches: when.linkedIssue === subject.linkedIssue, reason: subject.linkedIssue ? "it links an issue" : "it links no issue" });
  }
  if (when.ci) out.push({ matches: when.ci.includes(subject.ci), reason: `its CI is ${subject.ci}` });
  if (when.files) out.push(boundHolds(when.files, subject.files, "files"));
  if (when.lines) out.push(boundHolds(when.lines, subject.lines, "lines"));
  return out;
}

/** Whether every condition of a step holds; the first that does not, or else the first not known, says why. */
export function whenHolds(when: StepWhen | undefined, subject: StepSubject): Holds {
  if (when === undefined) return { matches: true, reason: "it has no conditions" };
  const held = conditions(when, subject);
  const blocking = held.find((h) => h.matches === false) ?? held.find((h) => h.matches === undefined);
  if (blocking) return blocking;
  return { matches: true, reason: held.map((h) => h.reason).join(", ") };
}
