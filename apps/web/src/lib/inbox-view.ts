import { AUTHOR_GROUPS, NO_CHANGES_REQUESTED, type AuthorKind, type AwaitedStage } from "@corbits/triage-contracts";
import type { MergeBlock, PrItem, QueueState } from "./hub-api.ts";
import { holdsActionForYou, mergesOnItsOwn, pendingDos, triageActed } from "./pending-dos.ts";
import { hostName } from "./pull-link.ts";
import { priorityRank } from "./triage-view.ts";

export type InboxAction = "decide" | "review" | "unblock" | "merge" | "failed";

const INBOX_ACTION_ORDER: InboxAction[] = ["decide", "review", "unblock", "merge", "failed"];

const INBOX_ACTION_LABEL: Record<InboxAction, string> = {
  decide: "Decide",
  review: "Review",
  unblock: "Unblock",
  merge: "Merge",
  failed: "Failed",
};

const INBOX_STATUS_LABEL: Record<QueueState, string> = {
  "needs-decision": "Needs your decision",
  "awaiting-review": "Waiting for review",
  "needs-author-update": "Waiting on author",
  blocked: "Blocked",
  ready: "Ready to merge",
  stale: "Rechecking",
  new: "Not triaged yet",
};

export type StatusFields = Pick<PrItem, "running" | "waitingForCi" | "state" | "draft" | "comment" | "checks" | "reviewAnswered">;

export function inboxStatus(item: StatusFields): string {
  if (item.running) return "Running";
  if (item.waitingForCi) return "Waiting for CI";
  // Triage skips drafts until they are marked ready, so a draft without a result is not waiting on it.
  if (item.state === "new" && item.draft) return "Draft";
  return INBOX_STATUS_LABEL[isReReview(item) ? "awaiting-review" : item.state];
}

export const UNASSIGNED = "Unassigned";

export type PrimaryAction = "reply" | "comment" | "approve" | "changes" | "close" | "merge" | "triage";

const PRIMARY_LABEL: Record<PrimaryAction, string> = {
  reply: "Post reply",
  comment: "Comment",
  approve: "Approve",
  changes: "Request changes",
  close: "Close",
  merge: "Merge",
  triage: "Triage again",
};

export function inboxAction(item: PrItem): InboxAction | null {
  switch (item.state) {
    case "needs-decision":
    case "stale":
      return "decide";
    case "awaiting-review":
      return "review";
    case "needs-author-update":
      return isReReview(item) ? "review" : "unblock";
    case "blocked":
      return "unblock";
    case "ready":
      return "merge";
    case "new":
      return item.failure === null && item.untriaged === undefined ? null : "failed";
  }
}

const BLOCK_ACTION: Record<MergeBlock, InboxAction> = {
  checking: "review",
  "review-required": "review",
  behind: "unblock",
  "changes-requested": "unblock",
  blocked: "unblock",
};

/** A pass is under Merge only once the host said it would merge it; otherwise it is listed where it gets looked at or unblocked. */
export function listedAction(item: PrItem): InboxAction | null {
  const action = inboxAction(item);
  if (action !== "merge") return action;
  if (item.mergeable === false) return "unblock";
  return item.mergeBlock === null ? "merge" : BLOCK_ACTION[item.mergeBlock];
}

export function isPostedToAuthor(item: PrItem): boolean {
  return item.state === "needs-author-update" && item.posted;
}

function onlyRequestedChanges(item: Omit<StatusFields, "running">): boolean {
  return item.state === "needs-author-update" && !hasDraftComment(item.comment) && item.checks.some((c) => c.check === NO_CHANGES_REQUESTED && c.result === "fail");
}

export function isReReview(item: Omit<StatusFields, "running">): boolean {
  return item.reviewAnswered && (item.state === "awaiting-review" || onlyRequestedChanges(item));
}

export function hasUncheckedCommits(item: Pick<PrItem, "verdictSha" | "headSha" | "waitingHeadSha">): boolean {
  const head = item.waitingHeadSha ?? item.headSha;
  return item.verdictSha !== null && head !== null && item.verdictSha !== head;
}

export function waitsOnAuthor(item: PrItem): boolean {
  return isPostedToAuthor(item) || (onlyRequestedChanges(item) && !item.reviewAnswered);
}

function awaitsYourDecision(item: PrItem): boolean {
  return item.pendingApprovalId !== null || holdsActionForYou(item);
}

const STAGE_TEXT: Record<AwaitedStage, string> = { judge: "the judgement rules", "code-review": "code review" };

/**
 * What Triage is doing or waiting on, in the order it comes, read from the hub's state of the run; null once it has
 * nothing under way. A draft is its author's until marked ready, so only a run already going counts for one.
 */
export function progressText(item: PrItem): string | null {
  if (item.running) return "checking this pull request";
  if (item.waitingForCi) return "waiting on CI";
  if (item.awaiting.length > 0) return `waiting on ${item.awaiting.map((stage) => STAGE_TEXT[stage]).join(", then ")}`;
  if (item.draft === true) return null;
  if (hasUncheckedCommits(item)) return "checking new commits";
  if (item.state === "stale") return "rechecking";
  return inboxAction(item) === null ? "not triaged yet" : null;
}

/**
 * Only a pull request with a decision for you: none while Triage is still at work on it, and a draft or one on its
 * author's turn only while something waits on your approval.
 */
export function inNeedsYou(item: PrItem): boolean {
  if (progressText(item) !== null) return false;
  if (awaitsYourDecision(item)) return true;
  return item.draft !== true && inboxAction(item) !== null && !waitsOnAuthor(item);
}

/** A comment only counts as a draft when it holds non-empty text; a degraded verdict's empty feedback is nothing to post. */
export function hasDraftComment(comment: string | null): boolean {
  return comment !== null && comment.trim() !== "";
}

export function primaryAction(item: PrItem, action: InboxAction | null): PrimaryAction | null {
  if (item.draft === true) return null;
  switch (action) {
    case null:
      return null;
    case "decide":
      return hasDraftComment(item.comment) ? "reply" : "comment";
    case "review":
      return "approve";
    case "unblock":
      if (item.state !== "needs-author-update") return "changes";
      if (isPostedToAuthor(item)) return null;
      return hasDraftComment(item.comment) ? "reply" : "comment";
    case "merge":
      return "merge";
    case "failed":
      return "triage";
  }
}

export type HandledKind = Exclude<PrimaryAction, "triage">;

/** `kind` is null for an entry stored before kinds were recorded. */
export type HandledMark = { kind: HandledKind | null };

export type WaitsOn = "maintainer" | "author" | "ci" | "triage" | "setup" | "nobody";

const WAITS_ON_ORDER: WaitsOn[] = ["maintainer", "author", "ci", "triage", "setup", "nobody"];

const WAITS_ON_LABEL: Record<WaitsOn, string> = {
  maintainer: "Waits on you",
  author: "Waits on author",
  ci: "Waits on CI",
  triage: "Waits on Triage",
  setup: "Needs setup",
  nobody: "Waits on nobody",
};

const AUTHOR_TURN: ReadonlySet<HandledKind | null> = new Set(["changes", "reply", "comment"]);

/** Who must act next, checked in order; `entry` is the pull request's handled mark, null while it is in Needs you. */
export function waitsOn(item: PrItem, entry: HandledMark | null): WaitsOn {
  if (progressText(item) !== null) return item.waitingForCi ? "ci" : "triage";
  if ((entry === null && inNeedsYou(item)) || awaitsYourDecision(item)) return "maintainer";
  if (item.draft === true || item.state === "needs-author-update" || (entry !== null && AUTHOR_TURN.has(entry.kind))) return "author";
  if (item.ci === "pending") return "ci";
  return "nobody";
}

/** `did` is what Triage did on its own and `reason` why; `person` also leaves the next step to you. */
export type ActionMode =
  | { mode: "waiting"; reason: string }
  | { mode: "person"; did: string; reason: string }
  | { mode: "automatic"; did: string; reason: string };

/** The step this pull request waits on is yours unless Triage will merge it. */
function nextStepIsYours(item: PrItem): boolean {
  return inNeedsYou(item) && !(inboxAction(item) === "merge" && mergesOnItsOwn(item));
}

/**
 * Waiting while a held action or an approval waits on you. A pending approval stays waiting after the pull request leaves
 * the open list, which clears needsHuman but keeps pendingApprovalId. Otherwise the card says what Triage did on its own,
 * beside your controls while the next step is still yours. Null when Triage did nothing on its own.
 */
export function actionMode(item: PrItem): ActionMode | null {
  const [pending] = pendingDos(item);
  if (pending !== undefined || item.pendingApprovalId !== null) {
    return { mode: "waiting", reason: pending?.reason ?? item.reasons[0] ?? item.nextAction ?? "Waiting for your approval." };
  }
  const acted = triageActed(item);
  if (acted === null) return null;
  return { mode: nextStepIsYours(item) ? "person" : "automatic", ...acted };
}

/** Triage decides nothing in a repository whose policy cannot run, so its pull requests waiting on Triage wait on its setup instead. */
export function waitsOnIn(entry: OpenItem, needsSetup: ReadonlySet<string>): WaitsOn {
  const waits = waitsOn(entry.item, entry.handled);
  return waits === "triage" && needsSetup.has(entry.item.repo) ? "setup" : waits;
}

const NOT_POSTED: Record<string, string> = {
  stale: "Triage could not reach a verdict and will check again.",
  waiting: "Triage is waiting for the checks to finish.",
  no_request: "There was nothing to post.",
  no_grants: "Triage may not post here. Allow it under Actions Triage takes on its own on the repository's page.",
};

/** Why the verdict is not on the pull request's host, when the run said. */
export function notPostedText(item: Pick<PrItem, "notPosted" | "source">): string | null {
  const why = item.notPosted === undefined ? undefined : NOT_POSTED[item.notPosted];
  return why === undefined ? null : `Not posted on ${hostName(item.source)}: ${why}`;
}

export function primaryLabel(action: PrimaryAction): string {
  return PRIMARY_LABEL[action];
}

function waitingSince(item: PrItem): number {
  return item.waitingSince ? Date.parse(item.waitingSince) : Number.MAX_SAFE_INTEGER;
}

function compareInboxItems(a: PrItem, b: PrItem): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  if (a.needsHuman !== b.needsHuman) return a.needsHuman ? -1 : 1;
  return waitingSince(a) - waitingSince(b);
}

type InboxGroup = { action: InboxAction; label: string; items: PrItem[] };

export type InboxView = { groups: InboxGroup[]; awaiting: number };

export function groupInbox(items: PrItem[], ready: ReadonlySet<string>): InboxView {
  const sorted = [...items].sort(compareInboxItems);
  const groups = INBOX_ACTION_ORDER
    .map((action) => ({ action, label: INBOX_ACTION_LABEL[action], items: sorted.filter((item) => inNeedsYou(item) && listedAction(item) === action) }))
    .filter((group) => group.items.length > 0);
  return { groups, awaiting: items.filter((item) => ready.has(item.repo) && inboxAction(item) === null).length };
}

export function awaitingText(count: number): string {
  return `${count} awaiting triage`;
}

export function matchesQuery(item: PrItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${item.title ?? ""} #${item.number ?? ""} ${item.repo} ${item.author ?? ""} ${item.owner ?? ""}`.toLowerCase().includes(normalized);
}

export type ListView = "needs-you" | "ready" | "all-open";

/** Ready, Open and All are filters on Triage. */
export type TriageView = ListView | "all";

const VIEW_PARAM = "view";

const FILTER_PARAM: Record<Exclude<TriageView, "needs-you">, string> = { ready: "ready", "all-open": "open", all: "all" };

const VIEW_FROM_PARAM: Record<string, TriageView> = { ready: "ready", open: "all-open", all: "all" };

/** Needs you has no filter in the address. Anything else is ignored. */
export function triageView(params: URLSearchParams): TriageView {
  const named = params.get(VIEW_PARAM);
  return named !== null && Object.hasOwn(VIEW_FROM_PARAM, named) ? VIEW_FROM_PARAM[named]! : "needs-you";
}

/** Keeps the other search filters. Waiting is only the Waiting tab, so choosing any slice drops it. */
export function withTriageView(params: URLSearchParams, view: TriageView): URLSearchParams {
  const next = new URLSearchParams(params);
  if (view === "needs-you") next.delete(VIEW_PARAM);
  else next.set(VIEW_PARAM, FILTER_PARAM[view]);
  next.delete("waiting");
  return next;
}

/** The list lives at `/`. A selected pull request is under `/pr/`, and the filter stays in the search string. A row with no number has no address. */
export function listHref(item: Pick<PrItem, "repo" | "number">): string | undefined {
  if (item.number === null) return undefined;
  return `/pr/${item.repo}/${item.number}`;
}

/**
 * Pulse, Inbox, Ready and Open, including a pull request open on them, become the same place on Triage.
 * Returns null when the path is not one of those pages.
 */
export function legacyTriageTarget(pathname: string, search: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  const root = parts[0];
  if (root !== "pulse" && root !== "inbox" && root !== "ready" && root !== "open") return null;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (root === "ready" || root === "open") params.set(VIEW_PARAM, root);
  const rest = root === "pulse" ? [] : parts.slice(1);
  const path = rest.length === 3 ? `/pr/${rest.join("/")}` : "/";
  const query = params.toString();
  return query === "" ? path : `${path}?${query}`;
}

export function repoOf(key: string): string {
  return key.slice(0, key.lastIndexOf("#"));
}

export type OpenItem = { item: PrItem; handled: HandledMark | null };

/** A pending approval or held action still needs a person after its repository's triage is turned off. */
export function allOpen(open: OpenItem[], enabled: ReadonlySet<string>): OpenItem[] {
  return open.filter((entry) => enabled.has(entry.item.repo) || awaitsYourDecision(entry.item));
}

function needsYouEntry(entry: OpenItem): boolean {
  return awaitsYourDecision(entry.item) || entry.handled === null;
}

/** All open less what you acted on, before `inNeedsYou` sets aside what waits on others. */
export function needsYou(open: OpenItem[], enabled: ReadonlySet<string>): OpenItem[] {
  return allOpen(open, enabled).filter(needsYouEntry);
}

/** Every open pull request outside Needs you, so the two together are All open. */
export function waitingOnOthers(open: OpenItem[], enabled: ReadonlySet<string>): OpenItem[] {
  return allOpen(open, enabled).filter((entry) => !needsYouEntry(entry) || !inNeedsYou(entry.item));
}

/** A pass on the head the host has now, with CI green, no conflicts, and the host's word that it would merge it. */
function isReadyToMerge(item: PrItem): boolean {
  return item.verdict === "pass" && item.verdictSha !== null && item.verdictSha === item.headSha && item.draft === false && item.ci === "success" && item.mergeable === true && item.mergeBlock === null;
}

/** Oldest pass first. */
export function readyToMerge(open: OpenItem[], enabled: ReadonlySet<string>): OpenItem[] {
  return allOpen(open, enabled).filter((entry) => isReadyToMerge(entry.item)).sort((a, b) => waitingSince(a.item) - waitingSince(b.item));
}

export function needsYouCount(open: OpenItem[], enabled: ReadonlySet<string>): number {
  return needsYou(open, enabled).filter((entry) => inNeedsYou(entry.item)).length;
}

/** All is every open pull request across the repositories Triage runs on, plus any merged or closed here before the next refresh. */
export function entriesFor(view: TriageView, open: OpenItem[], known: OpenItem[], enabled: ReadonlySet<string>): OpenItem[] {
  switch (view) {
    case "needs-you":
      return needsYou(open, enabled);
    case "ready":
      return readyToMerge(open, enabled);
    case "all-open":
      return allOpen(open, enabled);
    case "all":
      return allOpen(known, enabled);
  }
}

export const AUTHOR_KIND_LABEL: Record<AuthorKind, string> = {
  OWNER: "Owner",
  MEMBER: "Member",
  COLLABORATOR: "Collaborator",
  CONTRIBUTOR: "Contributor",
  FIRST_TIME_CONTRIBUTOR: "First-timer",
  FIRST_TIMER: "New to GitHub",
  NONE: "Outside",
  MANNEQUIN: "Imported",
  BOT: "Bot",
};

function isFirstTimer(kind: AuthorKind): boolean {
  return (AUTHOR_GROUPS["first-timers"] as readonly AuthorKind[]).includes(kind);
}

/** Only first-timers and bots change how a pull request is read; the other kinds stay quiet. */
export function isLoudAuthorKind(kind: AuthorKind): boolean {
  return isFirstTimer(kind) || kind === "BOT";
}

export type InboxGrouping = "action" | "repo" | "owner";

export const INBOX_GROUPINGS: InboxGrouping[] = ["action", "repo", "owner"];

export type OpenGrouping = "repo" | "waits" | "owner";

export const OPEN_GROUPINGS: OpenGrouping[] = ["repo", "waits", "owner"];

export { ageText } from "./duration.ts";

export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s@._-]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

export type InboxPile = { key: string; label: string; action: InboxAction | null; items: PrItem[] };

function pileBy<T>(ordered: T[], keyOf: (entry: T) => string): Array<{ key: string; items: T[] }> {
  const piles = new Map<string, T[]>();
  for (const entry of ordered) {
    const key = keyOf(entry);
    piles.set(key, [...(piles.get(key) ?? []), entry]);
  }
  return [...piles.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => ({ key, items }));
}

function ownerOf(item: PrItem): string {
  return item.owner ?? UNASSIGNED;
}

export function regroupInbox(view: InboxView, grouping: InboxGrouping): InboxPile[] {
  if (grouping === "action") return view.groups.map((group) => ({ key: group.action, label: group.label, action: group.action, items: group.items }));
  const ordered = view.groups.flatMap((group) => group.items);
  return pileBy(ordered, grouping === "repo" ? (item) => item.repo : ownerOf).map(({ key, items }) => ({ key, label: key, action: null, items }));
}

export type OpenPile = { key: string; label: string; items: OpenItem[] };

export function groupOpen(open: OpenItem[], grouping: OpenGrouping, needsSetup: ReadonlySet<string>): OpenPile[] {
  const sorted = [...open].sort((a, b) => compareInboxItems(a.item, b.item));
  if (grouping === "waits") {
    return WAITS_ON_ORDER
      .map((waits) => ({ key: waits, label: WAITS_ON_LABEL[waits], items: sorted.filter((entry) => waitsOnIn(entry, needsSetup) === waits) }))
      .filter((pile) => pile.items.length > 0);
  }
  const keyOf = grouping === "repo" ? (entry: OpenItem) => entry.item.repo : (entry: OpenItem) => ownerOf(entry.item);
  return pileBy(sorted, keyOf).map(({ key, items }) => ({ key, label: key, items }));
}
