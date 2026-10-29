import { askRules, citationOf, NO_CHANGES_REQUESTED, type ActionKind, type CheckPack, type VerdictWord } from "@corbits/triage-contracts";
import type { CheckResult, GithubPullDetail, HeldBlock, PrItem, RunFailure } from "./hub-api.ts";
import { paneActions, paneFacts, type ActionBlocker, type MenuEntry, type PaneFacts, type PaneGate, type PaneKind } from "./inbox-pane.ts";
import { inboxAction, inboxStatus, isPostedToAuthor, isReReview, failedOnNewCommits, hasUncheckedCommits, primaryLabel, progressText, triageStoppedOn, waitsOn, waitsOnAuthor, type HandledMark } from "./inbox-view.ts";
import { checkLabel, DO_NAMES } from "./pack-prose.ts";
import { pendingDos, postedActions, verdictNote, type PendingDo } from "./pending-dos.ts";
import { hostName } from "./pull-link.ts";
import { lowerFirst, upperFirst } from "./triage-view.ts";

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

/** The run read as one: what Triage is at, what it needs from you, what it ended with, or, with no verdict and no run, that it waits. */
type LineForm = "progress" | "you" | "done" | "waiting";

const FORM_LABEL: Record<LineForm, string> = { progress: "In progress", you: "Needs you", done: "Done", waiting: "Waiting" };

export type PaneStatus = { form: LineForm; tone: StatusTone; text: string; live: boolean };

/** The one line as a sentence, for the list's row and anything else that has room only for text. */
export function lineText({ form, text }: Pick<PaneStatus, "form" | "text">): string {
  return `${FORM_LABEL[form]}: ${text}`;
}

const FAILURE_TEXT: Record<RunFailure, string> = {
  failed: "the run failed",
  cancelled: "the run was cancelled",
  stuck: "the run stopped responding",
};

/** The verdict in the words of the label it puts on the pull request. */
const VERDICT_TEXT: Record<VerdictWord, string> = { pass: "Ready", fail: "Not ready", unsure: "Needs human review" };

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

function mergeHeldText(blocker: ActionBlocker, item: PrItem, detail: GithubPullDetail | undefined): string | null {
  return isHeldBlock(blocker) ? heldReason(blocker, detail) : notYetText(blocker, item);
}

/** Rule names, up to `shown`, with how many more. */
function ruleNames(problems: Problem[], pack: CheckPack | null, shown: number): string {
  const names = problems.map((problem) => checkLabel(pack, problem.check.check) ?? problem.check.check);
  const more = names.length - shown;
  const listed = names.slice(0, shown).join(", ");
  return more > 0 ? `${listed} +${more} more` : listed;
}

export function endedText(item: PrItem, detail: GithubPullDetail | undefined, handled: HandledMark | null): string | null {
  if (detail?.pr.merged || handled?.kind === "merge") return "Merged";
  if (detail?.pr.state === "closed" || item.closed || handled?.kind === "close") return "Closed";
  return null;
}

/** `detail` is the host's own read, which only the pane has; without it the list's read of the host stands in. */
export type StatusInput = { item: PrItem; detail: GithubPullDetail | undefined; handled: HandledMark | null; pack: CheckPack | null };

type Said = { tone: StatusTone; text: string };

function said(tone: StatusTone, text: string): Said {
  return { tone, text };
}

/** `text`, then up to `shown` rule names. */
function named(tone: StatusTone, text: string, problems: Problem[], pack: CheckPack | null, shown = 1): Said {
  return said(tone, `${text}${ruleNames(problems, pack, shown)}`);
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
function reReviewLine({ author, problems, pack }: Context): Said {
  const still = problems.fail.filter((problem) => problem.check.check !== NO_CHANGES_REQUESTED);
  const open: Array<[string, Problem[]]> = [["still not met: ", still], ["still to decide: ", problems.unsure], ["couldn't check: ", problems.cant]];
  const parts = open.filter(([, listed]) => listed.length > 0).map(([label, listed]) => `${label}${ruleNames(listed, pack, 1)}`);
  return said("you", `Re-review: ${author} updated it · ${parts.length > 0 ? parts.join(" · ") : "all rules met"}`);
}

/** What the main button does and what it is about; null where the button says nothing about the rules and one could not be checked, or there is none to say. */
function buttonLine(primary: MenuEntry | null, { item, author, problems: { fail, cant }, pack, facts, detail }: Context): Said | null {
  /** A line naming no rule gives way to the rules that could not be checked. */
  function unnamed(line: Said): Said | null {
    return cant.length > 0 ? null : line;
  }
  switch (primary?.kind) {
    case "reply":
      return fail.length > 0 ? named("you", `Ask ${author} to fix: `, fail, pack, 2) : unnamed(said("you", `Send feedback to ${author}`));
    case "changes": {
      if (fail.length > 0) return named("you", `Request changes from ${author}: `, fail, pack);
      const held = isHeldBlock(facts.hostBlock) ? `: ${heldReason(facts.hostBlock, detail)}` : "";
      return unnamed(said("you", `Request changes from ${author}${held}`));
    }
    case "approve":
      return fail.length > 0 ? named("you", `Approve anyway, or ask ${author} to fix: `, fail, pack) : unnamed(said("you", "Review and approve"));
    case "comment":
      return fail.length > 0 ? named("you", `Reply to ${author} · not met: `, fail, pack) : unnamed(said("you", `Reply to ${author}`));
    case "merge": {
      const why = primary.blocker === null ? null : mergeHeldText(primary.blocker, item, detail);
      if (why !== null) return said("you", `Can't merge yet: ${why}`);
      if (fail.length > 0) return named("you", "Ready to merge · still not met: ", fail, pack);
      return unnamed(said("ready", "Ready to merge"));
    }
    case undefined: {
      if (fail.length > 0) return named("you", "Not met: ", fail, pack);
      const held = item.state === "blocked" && isHeldBlock(facts.hostBlock) ? facts.hostBlock : null;
      return held === null ? null : unnamed(said("you", `Blocked: ${heldReason(held, detail)}`));
    }
    default:
      return null;
  }
}

/** Re-review, then rules to decide, then what the main button does, then rules that could not be checked. */
function ruledLine(context: Context): Said {
  const { item, facts, problems: { unsure, cant }, pack } = context;
  if (isReReview(item)) return reReviewLine(context);
  if (unsure.length > 0) return said("you", `Decide: ${ruleNames(unsure, pack, 1)} (${decideWhy(unsure)})`);
  const primary = paneBar({ item, facts, readOnly: false, busy: false }, null, facts.author).primary;
  const button = buttonLine(primary, context);
  if (button !== null) return button;
  if (cant.length > 0) return said("you", `Couldn't check ${ruleNames(cant, pack, 1)} · use Triage again in More`);
  return said("you", inboxStatus(item));
}

/**
 * After your approval the button has done its part, so the line says only what is still open, or what holds the merge.
 * Your approval answers the change you requested, so that is not listed as unmet.
 */
function approvedLine({ item, author, problems: { fail, unsure, cant }, pack, facts, detail }: Context): Said {
  const unmet = fail.filter((problem) => problem.check.check !== NO_CHANGES_REQUESTED);
  if (unmet.length > 0) return named("you", "You approved · still not met: ", unmet, pack);
  if (unsure.length > 0) return named("you", "You approved · still to decide: ", unsure, pack);
  if (cant.length > 0) return named("you", "You approved · couldn't check: ", cant, pack);
  if (isPostedToAuthor(item)) return said("author", `You approved · waiting on ${author}`);
  const primary = paneBar({ item, facts, readOnly: false, busy: false }, null, facts.author).primary;
  if (primary?.kind !== "merge") return said("quiet", "You approved");
  const why = primary.blocker === null ? null : mergeHeldText(primary.blocker, item, detail);
  return why === null ? said("ready", "You approved · ready to merge") : said("you", `You approved · can't merge yet: ${why}`);
}

/** The author's turn: what they are to fix, if anything failed. */
function authorsTurn({ author, problems: { fail }, pack }: Context): Said {
  return fail.length > 0 ? named("author", `waiting on ${author} to fix: `, fail, pack) : said("author", `waiting on ${author}`);
}

/** Where Triage may not post on its own, the verdict is not on the host, and workspace settings say what it may do. */
function notPostedText(item: PrItem): string[] {
  return item.notPosted === "no_grants" ? [`not posted on ${hostName(item.source)}: Triage may not post here on its own; workspace settings list what it does on its own in each repository`] : [];
}

/** The verdict as its label names it, what Triage posted on its own or could not post, then what the run left. */
function doneText(item: PrItem, rest: string): string {
  const verdict = item.verdict === null ? [] : [VERDICT_TEXT[item.verdict]];
  return upperFirst([...verdict, ...postedActions(item), ...notPostedText(item), rest].join(" · "));
}

/** A held comment or change request quotes what it posts, which may already end its sentence. */
const ENDS_IN_A_STOP = /[.!?]"?$/;

const ON_THE_PULL_REQUEST: ReadonlySet<ActionKind> = new Set(["approve", "close", "merge"]);

/** What a held action does, lower case, naming the pull request after a verb that acts on it alone. */
function heldAction(pending: Pick<PendingDo, "kind" | "label" | "list">): string {
  return ON_THE_PULL_REQUEST.has(pending.kind) ? `${lowerFirst(DO_NAMES[pending.kind])} this pull request${verdictNote(pending)}` : lowerFirst(pending.label);
}

/** A held action waiting on you is the decision even where the rules leave the turn to the author, asked as a question in its own verb. */
function heldForYouText(item: PrItem): string | null {
  const [pending] = pendingDos(item).filter((held) => held.until === null);
  if (pending === undefined) return item.pendingApprovalId === null ? null : "Confirm or dismiss the post Triage held, on the pull request's page";
  const action = upperFirst(heldAction(pending));
  return ENDS_IN_A_STOP.test(action) ? action : `${action}?`;
}

/** Without a rule left for you the turn is someone else's, unless an action waits on your approval. */
function settled(item: PrItem, line: Said): PaneStatus {
  if (line.tone === "you" || line.tone === "ready") return { form: "you", ...line, live: false };
  const held = heldForYouText(item);
  if (held !== null) return { form: "you", tone: "you", text: held, live: false };
  return { form: "done", ...line, live: false };
}

function failedText(item: PrItem): string {
  if (failedOnNewCommits(item)) return "Triage could not check the new commits";
  if (item.untriaged !== undefined) return item.untriaged;
  return item.failure === null ? "Couldn't triage" : `Couldn't triage: ${FAILURE_TEXT[item.failure]}`;
}

/** The line the verdict alone gives: what is left for you, or whose turn it is. */
function verdictLine(context: Context, handled: HandledMark | null): PaneStatus {
  const { item } = context;
  const authors = said("author", doneText(item, authorsTurn(context).text));
  if (handled === null) return settled(item, waitsOnAuthor(item) ? authors : ruledLine(context));
  if (handled.kind === "approve") return settled(item, approvedLine(context));
  return settled(item, waitsOn(item, handled) === "author" ? authors : ruledLine(context));
}

/** No run can start on a host where Triage is stopped, so only elsewhere is Triage again offered. */
function waitingText(item: PrItem): string {
  if (item.draft === true) return "draft";
  return triageStoppedOn(item) ? "not triaged yet" : "not triaged yet · Triage again";
}

/** Why the verdict may no longer stand: Triage could not settle it, or there are commits it has not checked. */
function unsettledText(item: PrItem): string | null {
  if (item.state === "stale") return "Triage could not settle it";
  return hasUncheckedCommits(item) ? "newer commits not yet checked" : null;
}

/**
 * The one line for where the pull request stands, read in one order: ended, what the hub says Triage is at, a failed run,
 * no verdict yet, a draft, then what the verdict leaves for you or the author, and whether it still stands. The row's
 * main button is read from the list, the pane's from the host's detail once it has loaded; that is the only way the two
 * can differ.
 */
export function paneStatus({ item, detail, handled, pack }: StatusInput): PaneStatus {
  const ended = endedText(item, detail, handled);
  if (ended !== null) return { form: "done", tone: "quiet", text: ended, live: false };
  const progress = progressText(item);
  if (progress !== null) return { form: "progress", tone: "quiet", text: upperFirst(progress), live: item.running };
  // A draft has no main button, so Triage again waits in More.
  if (inboxAction(item) === "failed") return { form: "you", tone: "you", text: `${failedText(item)} · ${item.draft === true ? "use Triage again in More" : "Triage again"}`, live: false };
  if (item.verdict === null) return { form: "waiting", tone: "quiet", text: waitingText(item), live: false };
  const facts = paneFacts(item, detail);
  const author = facts.author === null ? "the author" : `@${facts.author}`;
  const context: Context = { item, author, problems: bySeverity(item, pack), pack, facts, detail };
  if (item.draft === true) return settled(item, said("author", doneText(item, `draft · waiting on ${author}`)));
  const line = verdictLine(context, handled);
  const unsettled = unsettledText(item);
  if (unsettled === null) return line;
  const held = heldForYouText(item);
  // Neither a verdict Triage could not settle nor a pass on unchecked commits asks you anything but the held action.
  if (held !== null && (item.state === "stale" || inboxAction(item) === "merge")) return { form: "you", tone: "you", text: `${held} · ${unsettled}`, live: false };
  // Commits Triage has not checked are never merged, so a pass has nothing for you until Triage checks them.
  if (item.state !== "stale" && line.form === "you" && inboxAction(item) !== "merge") return { ...line, text: `${line.text} · ${unsettled}` };
  if (item.state !== "stale") return { ...line, form: "done", text: `${line.text} · ${unsettled} · Triage again` };
  return { form: "done", tone: "quiet", text: doneText(item, `${unsettled} · Triage again`), live: false };
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

/** `entry` is the bar's button that carries the held action out, null for one with no button; `primary` when that is the primary. */
export type HeldChoice = { pending: PendingDo; entry: BarEntry | null; primary: boolean };

/** Every held action on the bar, the primary's included, so each can be read with its reason and hidden. */
export function heldChoices(bar: PaneBar): HeldChoice[] {
  const entries: BarEntry[] = bar.primary === null ? bar.rest : [bar.primary, ...bar.rest];
  const carried = entries.flatMap((entry) => entry.held === null ? [] : [{ pending: entry.held, entry, primary: entry === bar.primary }]);
  return [...carried, ...bar.dos.map((pending) => ({ pending, entry: null, primary: false }))];
}

/** A held action as the line under the status says it: when it will run on its own, or what Triage would do once you let it. */
export function heldText(pending: Pick<PendingDo, "kind" | "label" | "list" | "until">): string {
  if (pending.until !== null) return `Will run when ${pending.until}: ${lowerFirst(pending.label)}`;
  const said = heldAction(pending);
  return `Triage would ${said}${ENDS_IN_A_STOP.test(said) ? "" : "."}`;
}
