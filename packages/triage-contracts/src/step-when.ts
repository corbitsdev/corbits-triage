import type { AuthorGroup, AuthorKind, AuthorMatch, CiState, SizeBound, StepWhen } from "./check-pack.js";

const AUTHOR_GROUP_KINDS: Record<AuthorGroup, readonly AuthorKind[]> = {
  "first-timers": ["first-timer"],
  maintainers: ["owner", "member", "collaborator"],
  external: ["contributor", "first-timer", "outside"],
  bots: ["bot"],
};

export type StepAuthor = { login: string; kind?: AuthorKind; teams?: readonly string[]; teamsUnknown?: readonly string[] };

/** What a step's conditions are read against. */
export type StepSubject = { author: StepAuthor; linkedIssue: boolean; ci: CiState; files: number; lines: number };

/** `matches` is undefined when what the condition reads is not known. */
export type Holds = { matches: boolean | undefined; reason: string };

function matchName(match: AuthorMatch): string {
  if (typeof match === "string") return match;
  return "team" in match ? match.team : match.users.join(", ");
}

function authorMatches(match: AuthorMatch, author: StepAuthor): boolean | undefined {
  if (typeof match === "string") return author.kind === undefined ? undefined : AUTHOR_GROUP_KINDS[match].includes(author.kind);
  if ("users" in match) return match.users.some((login) => login.toLowerCase() === author.login.toLowerCase());
  if (author.teams?.includes(match.team)) return true;
  if (!author.teams || author.teamsUnknown?.includes(match.team)) return undefined;
  return false;
}

function authorHolds(matches: readonly AuthorMatch[], author: StepAuthor): Holds {
  const names = matches.map(matchName).join(" or ");
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
