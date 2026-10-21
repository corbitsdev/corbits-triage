import { citationOf, type ActionKind } from "@corbits/triage-contracts";
import type { CheckResult, GithubPullDetail, HeldBlock, MergeBlock, PrItem, QueueState, RunFailure } from "./hub-api.ts";
import { currentHead, hasUncheckedCommits, paneActions, type ActionBlocker, type MenuEntry, type PaneGate, type PaneKind } from "./inbox-pane.ts";
import { inboxAction, inboxStatus, isPostedToAuthor, isReReview, postedLabel, primaryLabel, waitsOn, type HandledMark } from "./inbox-view.ts";
import { pendingDos, type PendingDo } from "./pending-dos.ts";
import { upperFirst } from "./triage-view.ts";

/** A failed check is something to fix; a model check the judge did not settle is the maintainer's call; anything else unconfirmed could not be checked. */
export type Severity = "fail" | "unsure" | "cant";

export type Problem = { check: CheckResult; severity: Severity; text: string | null; cited: string[]; notes: string[] };

/** An author rule never fails a pull request, so it is a problem only when it could not be decided. */
function severityOf(check: CheckResult): Severity | null {
  if (check.result === "pass") return null;
  if (check.result === "fail") return check.gate ? null : "fail";
  if (check.gate) return "cant";
  if (check.output?.kind === "score" || (check.output === null && check.kind === "model")) return "unsure";
  return "cant";
}

const SEVERITY_ORDER: Severity[] = ["fail", "unsure", "cant"];

/** What stands in the way, failures first; `text` is null when the check gave no reason, so its name stands in. */
export function paneProblems(checks: CheckResult[]): Problem[] {
  const problems = checks.flatMap((check) => {
    const severity = severityOf(check);
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
const NOT_YET: Partial<Record<ActionBlocker, string>> = {
  draft: "Ready, but it's a draft",
  "not-mergeable": "Ready, but has conflicts",
  "mergeability-unknown": "Ready, once GitHub has checked for conflicts",
};

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

function things(count: number): string {
  return `${count} ${count === 1 ? "thing" : "things"}`;
}

function status(tone: StatusTone, text: string): PaneStatus {
  return { tone, text, live: false };
}

export function approvedByTriage(item: PrItem): boolean {
  const head = currentHead(item);
  return head !== null && head === item.verdictSha && item.actions.some((action) => action.kind === "approve" && (action.status === "done" || action.status === "satisfied"));
}

export function endedText(item: PrItem, detail: GithubPullDetail | undefined, handled: HandledMark | null): string | null {
  if (detail?.pr.merged || handled?.kind === "merge") return "Merged";
  if (detail?.pr.state === "closed" || item.closed || handled?.kind === "close") return "Closed";
  return null;
}

export type StatusInput = {
  item: PrItem;
  detail: GithubPullDetail | undefined;
  handled: HandledMark | null;
  approved: boolean;
  /** The bar's primary, so the line never asks for what the button does not do. */
  primary: MenuEntry | null;
};

function problemsText(item: PrItem, primary: MenuEntry | null, fix: number, check: number): string {
  const rest = check > 0 ? `, ${check} to check` : "";
  if (primary?.kind === "reply" || primary?.kind === "comment") return `Needs your reply · ${things(fix)} to fix${rest}`;
  return `${inboxStatus(item)} · ${things(fix)} to fix${rest}`;
}

const BLOCK_ROW_STATUS: Record<MergeBlock, string> = {
  checking: "Checking merge state",
  behind: "Behind base",
  "review-required": "Waiting for review",
  "changes-requested": "Changes requested",
  blocked: "Merge blocked",
};

const ROW_STATUS: Record<QueueState, string> = {
  "needs-decision": "Your call",
  "awaiting-review": "Needs review",
  "needs-author-update": "Waiting on author",
  blocked: "Blocked",
  ready: "Ready",
  stale: "Rechecking",
  new: "Not triaged",
};

/** A few words for where the pull request stands, for its row in a list; `handled` is what you did, null in Needs you. */
export function rowStatus(item: PrItem, handled: HandledMark | null): string {
  if (item.running || item.waitingForCi) return inboxStatus(item);
  if (item.draft) return "Draft";
  const posted = handled === null ? null : postedLabel(item, handled);
  if (posted !== null) return posted;
  if (inboxAction(item) === "failed") return "Couldn't triage";
  const fix = paneProblems(item.checks).filter((problem) => problem.severity === "fail").length;
  if (fix > 0) return `${fix} to fix`;
  if (item.state === "ready" && item.mergeable === false) return "Has conflicts";
  if (item.state === "ready" && item.mergeBlock !== null) return BLOCK_ROW_STATUS[item.mergeBlock];
  return ROW_STATUS[isReReview(item) ? "awaiting-review" : item.state];
}

/** One line for where the pull request stands, read from the same verdict state, waits-on and actions as the list and the bar. */
export function paneStatus({ item, detail, handled, approved, primary }: StatusInput): PaneStatus {
  const ended = endedText(item, detail, handled);
  if (ended !== null) return status("quiet", ended);
  if (item.running) return { ...status("quiet", "Triage running…"), live: true };
  if (item.waitingForCi) return status("quiet", hasUncheckedCommits(item) ? "Waiting for CI · new commits since Triage checked" : "Waiting for CI");
  if (inboxAction(item) === "failed" && item.failure !== null) return status("quiet", `Couldn't triage: ${FAILURE_TEXT[item.failure]}`);
  if (item.state === "new" || item.state === "stale") return status("quiet", inboxStatus(item));
  if (hasUncheckedCommits(item)) return status("quiet", "New commits since Triage checked · rechecking");
  const problems = paneProblems(item.checks);
  const fix = problems.filter((problem) => problem.severity === "fail").length;
  const unsure = problems.filter((problem) => problem.severity === "unsure").length;
  const check = problems.length - fix;
  const author = item.author === null ? "the author" : `@${item.author}`;
  if (item.draft === true) return status("author", `Draft · waiting on ${author}`);
  if (handled?.kind === "approve") {
    if (fix === 0) return status("ready", "You approved · ready to merge");
    return status("you", `You approved · ${fix} ${fix === 1 ? "rule" : "rules"} failing`);
  }
  if (isPostedToAuthor(item) || (handled !== null && waitsOn(item, handled) === "author")) {
    return status("author", fix > 0 ? `Waiting on ${author} to fix ${things(fix)}` : `Waiting on ${author}`);
  }
  if (isReReview(item)) return status("you", "Ready for your re-review");
  if (fix > 0) return status("you", problemsText(item, primary, fix, check));
  if (unsure > 0) return status("you", `Not sure about ${things(check)} — your call`);
  if (check > 0) return status("you", `Couldn't check ${things(check)}: ${problems.filter((problem) => problem.severity === "cant").map((problem) => problem.text ?? problem.check.check).join("; ")}`);
  if (item.state !== "ready") return status("you", inboxStatus(item));
  const blocker = primary?.kind === "merge" ? primary.blocker : null;
  if (isHeldBlock(blocker)) return status("you", `Ready, but ${heldReason(blocker, detail)}`);
  const blocked = blocker === null ? undefined : NOT_YET[blocker];
  if (blocked !== undefined) return status("you", blocked);
  return status("ready", approved ? "Approved by Triage · ready for you to merge" : "Ready to merge");
}

/** `held` is Triage's held action of the same kind, which the button completes instead of writing a second one. */
export type BarEntry = MenuEntry & { held: PendingDo | null };

type BarAction = BarEntry & { detail: string | null };

/** `dos` are the held actions no other button stands for. */
export type PaneBar = { primary: BarAction | null; rest: BarEntry[]; dos: PendingDo[] };

const HELD_KIND: Partial<Record<PaneKind, ActionKind>> = { approve: "approve", changes: "request-changes", close: "close", merge: "merge" };

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
    return { ...entry, held: dos.find((pending) => pending.kind === HELD_KIND[entry.kind]) ?? null };
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
