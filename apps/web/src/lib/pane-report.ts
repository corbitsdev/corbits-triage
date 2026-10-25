import { askRules, citationOf, NO_CHANGES_REQUESTED, type CheckPack } from "@corbits/triage-contracts";
import type { CheckResult, GithubPullDetail, HeldBlock, PrItem, RunFailure } from "./hub-api.ts";
import { hasUncheckedCommits, paneActions, paneFacts, type ActionBlocker, type MenuEntry, type PaneFacts, type PaneGate, type PaneKind } from "./inbox-pane.ts";
import { inboxAction, inboxStatus, isPostedToAuthor, isReReview, postedLabel, primaryLabel, waitsOn, type HandledMark } from "./inbox-view.ts";
import { checkLabel } from "./pack-prose.ts";
import { pendingDos, type PendingDo } from "./pending-dos.ts";
import { hostName } from "./pull-link.ts";
import { upperFirst } from "./triage-view.ts";

/**
 * A failed check is something to fix, unless the policy asks a maintainer about it; that and a model check the judge did
 * not settle are the maintainer's call; anything else unconfirmed could not be checked.
 */
export type Severity = "fail" | "unsure" | "cant";

export type Problem = { check: CheckResult; severity: Severity; text: string | null; cited: string[]; notes: string[] };

/** An author rule never fails a pull request, so it is a problem only when it could not be decided. */
function severityOf(check: CheckResult, ask: readonly string[]): Severity | null {
  if (check.result === "pass") return null;
  if (check.result === "fail" && check.gate) return null;
  if (check.result === "fail") return ask.includes(check.check) ? "unsure" : "fail";
  if (check.gate) return "cant";
  if (check.output?.kind === "score" || (check.output === null && check.kind === "model")) return "unsure";
  return "cant";
}

const SEVERITY_ORDER: Severity[] = ["fail", "unsure", "cant"];

/** What stands in the way, failures first; `text` is null when the check gave no reason, so its name stands in. */
export function paneProblems(checks: CheckResult[], pack: CheckPack | null): Problem[] {
  const ask = pack === null ? [] : askRules(pack);
  const problems = checks.flatMap((check) => {
    const severity = severityOf(check, ask);
    if (severity === null) return [];
    const cited = check.evidence.filter((evidence) => citationOf(check.output, evidence) !== undefined);
    const notes = check.evidence.filter((evidence) => !cited.includes(evidence));
    return [{ check, severity, text: check.reason ? upperFirst(check.reason) : null, cited, notes }];
  });
  return SEVERITY_ORDER.flatMap((severity) => problems.filter((problem) => problem.severity === severity));
}

export function passedChecks(checks: CheckResult[]): CheckResult[] {
  return checks.filter((check) => check.result === "pass");
}

type StatusTone = "ready" | "you" | "author" | "quiet";

export type PaneStatus = { tone: StatusTone; text: string; live: boolean };

const FAILURE_TEXT: Record<RunFailure, string> = {
  failed: "the run failed",
  cancelled: "the run was cancelled",
  stuck: "the run stopped responding",
};

/** Why a ready pull request cannot merge yet, when the merge is what holds it. */
function notYetText(blocker: ActionBlocker, item: PrItem): string | null {
  switch (blocker) {
    case "draft": return "it's a draft";
    case "not-mergeable": return "it has conflicts";
    case "mergeability-unknown": return `${hostName(item.source)} hasn't checked for conflicts`;
    default: return null;
  }
}

const HELD_REASON: Record<HeldBlock, string> = {
  behind: "behind its base branch",
  "review-required": "waiting for a required review",
  "changes-requested": "changes are requested",
  blocked: "the branch's rules block the merge",
};

export function isHeldBlock(blocker: ActionBlocker | null): blocker is HeldBlock {
  return blocker !== null && blocker in HELD_REASON;
}

/** Why the host holds the merge; Bitbucket's merge checks name their own reasons. */
export function heldReason(block: HeldBlock, detail: GithubPullDetail | undefined): string {
  const vetoes = detail?.pr.mergeVetoes ?? [];
  if (block === "blocked" && vetoes.length) return `the merge checks say: ${vetoes.join("; ")}`;
  return HELD_REASON[block];
}

/** The list's own word for what holds the merge, read from the host before any pane opens it. */
const HELD_ROW: Record<HeldBlock, string> = {
  behind: "Behind base",
  "review-required": "Waiting for review",
  "changes-requested": "Changes requested",
  blocked: "Merge blocked",
};

function heldRowText(blocker: ActionBlocker): string | null {
  if (isHeldBlock(blocker)) return HELD_ROW[blocker];
  if (blocker === "mergeability-unknown") return "Checking merge state";
  if (blocker === "not-mergeable") return "Has conflicts";
  return blocker === "draft" ? "Draft" : null;
}

/** Words for a status, with how many more rules than it names; the reasons are in the problem rows, so a status names only rules. */
export type StatusWords = { text: string; more: number };

function ruleNames(problems: Problem[], pack: CheckPack | null, shown: number): StatusWords {
  const names = problems.map((problem) => checkLabel(pack, problem.check.check) ?? problem.check.check);
  return { text: names.slice(0, shown).join(", "), more: Math.max(names.length - shown, 0) };
}

export function moreText(more: number): string {
  return `+${more} more`;
}

export function statusText({ text, more }: StatusWords): string {
  return more > 0 ? `${text} ${moreText(more)}` : text;
}

function plain(text: string): StatusWords {
  return { text, more: 0 };
}

export function endedText(item: PrItem, detail: GithubPullDetail | undefined, handled: HandledMark | null): string | null {
  if (detail?.pr.merged || handled?.kind === "merge") return "Merged";
  if (detail?.pr.state === "closed" || item.closed || handled?.kind === "close") return "Closed";
  return null;
}

/** `detail` is the host's own read, which only the pane has; without it the list's read of the host stands in. */
export type StatusInput = { item: PrItem; detail: GithubPullDetail | undefined; handled: HandledMark | null; pack: CheckPack | null };

/** The pane's line and the row's shortened one, said with the same verb. */
type Standing = { tone: StatusTone; pane: string; row: StatusWords; live: boolean };

function line(tone: StatusTone, pane: string, row: string | StatusWords): Standing {
  return { tone, pane, row: typeof row === "string" ? plain(row) : row, live: false };
}

/** The pane names up to `shown` rules after `pane`; the row names one after `row`. */
function named(tone: StatusTone, pane: string, row: string, problems: Problem[], pack: CheckPack | null, shown = 1): Standing {
  const one = ruleNames(problems, pack, 1);
  return line(tone, `${pane}${statusText(ruleNames(problems, pack, shown))}`, { ...one, text: `${row}${one.text}` });
}

type Severities = Record<Severity, Problem[]>;

function bySeverity(item: PrItem, pack: CheckPack | null): Severities {
  const problems = paneProblems(item.checks, pack);
  return {
    fail: problems.filter((problem) => problem.severity === "fail"),
    unsure: problems.filter((problem) => problem.severity === "unsure"),
    cant: problems.filter((problem) => problem.severity === "cant"),
  };
}

/** Why a rule is yours to decide: the judge was not sure, or the policy asks a maintainer when it fails. */
function decideWhy(unsure: Problem[]): string {
  const asked = unsure.filter((problem) => problem.check.result === "fail").length;
  if (asked === 0) return "Triage wasn't sure";
  return asked === unsure.length ? "your policy asks you" : "see why below";
}

type Context = { item: PrItem; author: string; problems: Severities; pack: CheckPack | null; facts: PaneFacts; detail: GithubPullDetail | undefined };

/** What a re-review finds still open; the requested change is what it answers, so it is not listed. */
function reReviewLine({ author, problems, pack }: Context): Standing {
  const still = problems.fail.filter((problem) => problem.check.check !== NO_CHANGES_REQUESTED);
  const open: Array<[string, Problem[]]> = [["still not met: ", still], ["still to decide: ", problems.unsure], ["couldn't check: ", problems.cant]];
  const parts = open.filter(([, listed]) => listed.length > 0).map(([label, listed]) => `${label}${statusText(ruleNames(listed, pack, 1))}`);
  return line("you", `Re-review: ${author} updated it · ${parts.length > 0 ? parts.join(" · ") : "all rules met"}`, "Re-review");
}

/**
 * What the main button does and what it is about; null where the button says nothing about the rules and one could not
 * be checked, or there is none to say. Once the feedback is posted the turn is the author's, whatever reply the bar offers.
 */
function buttonLine(primary: MenuEntry | null, { item, author, problems: { fail, cant }, pack, facts, detail }: Context): Standing | null {
  if (isPostedToAuthor(item)) return fail.length > 0 ? { ...named("author", `Waiting on ${author} to fix: `, "", fail, pack), row: plain(`Waiting on ${author}`) } : line("author", `Waiting on ${author}`, `Waiting on ${author}`);
  /** A line naming no rule gives way to the rules that could not be checked. */
  function unnamed(said: Standing): Standing | null {
    return cant.length > 0 ? null : said;
  }
  switch (primary?.kind) {
    case "reply":
      return fail.length > 0 ? named("you", `Ask ${author} to fix: `, "Ask to fix: ", fail, pack, 2) : unnamed(line("you", `Send feedback to ${author}`, "Send feedback"));
    case "changes": {
      if (fail.length > 0) return named("you", `Request changes from ${author}: `, "Request changes: ", fail, pack);
      const held = isHeldBlock(facts.hostBlock) ? `: ${heldReason(facts.hostBlock, detail)}` : "";
      return unnamed(line("you", `Request changes from ${author}${held}`, "Request changes"));
    }
    case "approve":
      return fail.length > 0 ? named("you", `Approve anyway, or ask ${author} to fix: `, "Review: ", fail, pack) : unnamed(line("you", "Review and approve", "Review"));
    case "comment":
      return fail.length > 0 ? named("you", `Reply to ${author} · not met: `, "Reply: ", fail, pack) : unnamed(line("you", `Reply to ${author}`, "Reply"));
    case "merge": {
      const blocker = primary.blocker;
      const row = blocker === null ? null : heldRowText(blocker);
      if (blocker !== null && row !== null) return line("you", `Can't merge yet: ${isHeldBlock(blocker) ? heldReason(blocker, detail) : notYetText(blocker, item)}`, row);
      if (fail.length > 0) return named("you", "Ready to merge · still not met: ", "Ready to merge: not met ", fail, pack);
      return unnamed(line("ready", "Ready to merge", "Ready to merge"));
    }
    case undefined: {
      if (fail.length > 0) return named("you", "Not met: ", "Not met: ", fail, pack);
      const held = item.state === "blocked" && isHeldBlock(facts.hostBlock) ? facts.hostBlock : null;
      return held === null ? null : unnamed(line("you", `Blocked: ${heldReason(held, detail)}`, "Blocked"));
    }
    default:
      return null;
  }
}

/** Re-review, then rules to decide, then what the main button does, then rules that could not be checked. */
function ruledLine(context: Context): Standing {
  const { item, facts, problems: { unsure, cant }, pack } = context;
  if (isReReview(item)) return reReviewLine(context);
  if (unsure.length > 0) {
    const decide = named("you", "Decide: ", "Decide: ", unsure, pack);
    return { ...decide, pane: `${decide.pane} (${decideWhy(unsure)})` };
  }
  const primary = paneBar({ item, facts, readOnly: false, busy: false }, null, facts.author).primary;
  const button = buttonLine(primary, context);
  if (button !== null) return button;
  if (cant.length > 0) {
    const checked = named("you", "Couldn't check ", "Couldn't check: ", cant, pack);
    return { ...checked, pane: `${checked.pane} · use Triage again in More` };
  }
  return line("you", inboxStatus(item), inboxStatus(item));
}

/**
 * After your approval the button has done its part, so the line says only what is still open, or what holds the merge.
 * Your approval answers the change you requested, so that is not listed as unmet.
 */
function approvedLine({ item, author, problems: { fail, unsure, cant }, pack, facts, detail }: Context): Standing {
  const unmet = fail.filter((problem) => problem.check.check !== NO_CHANGES_REQUESTED);
  if (unmet.length > 0) return named("you", "You approved · still not met: ", "", unmet, pack);
  if (unsure.length > 0) return named("you", "You approved · still to decide: ", "", unsure, pack);
  if (cant.length > 0) return named("you", "You approved · couldn't check: ", "", cant, pack);
  if (isPostedToAuthor(item)) return line("author", `You approved · waiting on ${author}`, "");
  const primary = paneBar({ item, facts, readOnly: false, busy: false }, null, facts.author).primary;
  if (primary?.kind !== "merge") return line("you", "You approved", "");
  const { blocker } = primary;
  if (blocker === null || heldRowText(blocker) === null) return line("ready", "You approved · ready to merge", "");
  return line("you", `You approved · can't merge yet: ${isHeldBlock(blocker) ? heldReason(blocker, detail) : notYetText(blocker, item)}`, "");
}

/**
 * Where the pull request stands, for the pane's status line and, shortened, its row in a list, read in one order: ended,
 * running, CI, a failed run, a draft, not triaged or rechecking, commits Triage has not checked, what you did, a re-review,
 * rules to decide, what the main button does, rules that could not be checked. The row's main button is read from the
 * list, the pane's from the host's detail once it has loaded; that is the only way the two can differ.
 */
function standing({ item, detail, handled, pack }: StatusInput): Standing {
  const ended = endedText(item, detail, handled);
  if (ended !== null) return line("quiet", ended, ended);
  if (item.running) return { ...line("quiet", "Triage running…", inboxStatus(item)), live: true };
  if (item.waitingForCi) return line("quiet", hasUncheckedCommits(item) ? "Waiting for CI · new commits since Triage checked" : "Waiting for CI", "Waiting for CI");
  if (inboxAction(item) === "failed") {
    // A draft has no main button, so Triage again waits in More.
    const why = item.failure === null ? "Couldn't triage" : `Couldn't triage: ${FAILURE_TEXT[item.failure]}`;
    return line("quiet", item.draft === true ? `${why} · use Triage again in More` : why, "Couldn't triage");
  }
  const facts = paneFacts(item, detail);
  const author = facts.author === null ? "the author" : `@${facts.author}`;
  if (item.draft === true) return line("author", `Draft · waiting on ${author}`, "Draft");
  if (item.state === "new" || item.state === "stale") return line("quiet", inboxStatus(item), inboxStatus(item));
  if (hasUncheckedCommits(item)) return line("quiet", "New commits since Triage checked · rechecking", "Rechecking");
  const problems = bySeverity(item, pack);
  const context: Context = { item, author, problems, pack, facts, detail };
  if (handled === null) return ruledLine(context);
  const posted = postedLabel(item, handled) ?? inboxStatus(item);
  if (handled.kind === "approve") return { ...approvedLine(context), row: plain(posted) };
  if (waitsOn(item, handled) === "author") return problems.fail.length > 0 ? { ...named("author", `Waiting on ${author} to fix: `, "", problems.fail, pack), row: plain(posted) } : line("author", `Waiting on ${author}`, posted);
  return { ...ruledLine(context), row: plain(posted) };
}

/** A few words for the pull request's row in a list: the pane's status line, shortened; `more` is apart so the row can cut the names and keep the count. */
export function rowStatus(item: PrItem, handled: HandledMark | null, pack: CheckPack | null): StatusWords {
  return standing({ item, detail: undefined, handled, pack }).row;
}

/** One line for where the pull request stands: what the main button does and what it is about. */
export function paneStatus(input: StatusInput): PaneStatus {
  const { tone, pane, live } = standing(input);
  return { tone, text: pane, live };
}

/** `held` is Triage's held action with the same kind and label, which the button completes instead of writing a second one. */
export type BarEntry = MenuEntry & { held: PendingDo | null };

type BarAction = BarEntry & { detail: string | null };

/** `dos` are the held actions no other button stands for. */
export type PaneBar = { primary: BarAction | null; rest: BarEntry[]; dos: PendingDo[] };

function primaryText(kind: PaneKind, author: string | null, base: string | null): Pick<BarAction, "label" | "detail"> {
  const to = author === null ? null : `to @${author}`;
  switch (kind) {
    case "merge": return { label: "Merge", detail: base === null ? null : `into ${base}` };
    case "reply": return { label: "Send feedback", detail: to };
    case "comment": return { label: "Reply", detail: to };
    default: return { label: primaryLabel(kind), detail: null };
  }
}

/**
 * The bottom bar: the pane's primary action, worded for the state, then every other action. Once the feedback is on
 * GitHub the author has the turn, so replying to them comes first.
 */
export function paneBar(gate: PaneGate, base: string | null, author: string | null): PaneBar {
  const actions = paneActions(gate);
  const dos = pendingDos(gate.item);
  function withHeld<E extends MenuEntry>(entry: E): E & { held: PendingDo | null } {
    return { ...entry, held: dos.find((pending) => pending.kind === entry.kind && pending.label === primaryLabel(entry.kind)) ?? null };
  }
  const fallback = actions.primary === null && isPostedToAuthor(gate.item) ? actions.more.find((entry) => entry.kind === "comment") ?? null : null;
  // Commits Triage has not checked are never merged from here; the merge stays blocked until the hub has checked them.
  const checked = actions.primary?.blocker === "unchecked-commits" ? null : actions.primary;
  const primaryEntry = checked ?? fallback;
  const primary = primaryEntry === null ? null : withHeld({ ...primaryEntry, ...primaryText(primaryEntry.kind, author, base) });
  const demoted = actions.primary === null || checked !== null ? [] : [{ ...actions.primary, label: primaryLabel(actions.primary.kind) }];
  const rest = [...demoted, ...actions.more.filter((entry) => entry !== fallback)].map(withHeld);
  const taken = [primary, ...rest].map((entry) => entry?.held);
  return { primary, rest, dos: dos.filter((pending) => !taken.includes(pending)) };
}

/** `entry` is the bar's button that carries the held action out, null for one with no button. */
export type HeldChoice = { pending: PendingDo; entry: BarEntry | null };

/** Every held action on the bar, the primary's included, so each can be read with its reason and hidden. */
export function heldChoices(bar: PaneBar): HeldChoice[] {
  const entries: BarEntry[] = bar.primary === null ? bar.rest : [bar.primary, ...bar.rest];
  const carried = entries.flatMap((entry) => entry.held === null ? [] : [{ pending: entry.held, entry }]);
  return [...carried, ...bar.dos.map((pending) => ({ pending, entry: null }))];
}
