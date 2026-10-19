import { AUTHOR_GROUPS, NO_CHANGES_REQUESTED, type AuthorKind } from "@corbits/triage-contracts";
import type { PrItem, QueueState } from "./hub-api.ts";
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
  close: "Close pull request",
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
      return item.failure === null ? null : "failed";
  }
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

function waitsOnAuthor(item: PrItem): boolean {
  return isPostedToAuthor(item) || (onlyRequestedChanges(item) && !item.reviewAnswered);
}

/**
 * A pull request with a verdict that needs you stays while Triage checks it again or waits for CI, so it does not flicker out.
 * A draft is its author's until marked ready, whatever its last verdict said.
 */
export function inNeedsYou(item: PrItem): boolean {
  if (item.pendingApprovalId !== null) return true;
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
  if ((entry === null && inNeedsYou(item)) || item.pendingApprovalId !== null) return "maintainer";
  if (item.draft === true || item.state === "needs-author-update" || (entry !== null && AUTHOR_TURN.has(entry.kind))) return "author";
  if (item.ci === "pending" || item.waitingForCi) return "ci";
  if (inboxAction(item) === null) return "triage";
  return "nobody";
}

/** Triage never runs in a repository whose policy cannot run, so its untriaged pull requests wait on its setup instead. */
export function waitsOnIn(entry: OpenItem, needsSetup: ReadonlySet<string>): WaitsOn {
  const waits = waitsOn(entry.item, entry.handled);
  return waits === "triage" && needsSetup.has(entry.item.repo) ? "setup" : waits;
}

const POSTED_LABEL: Record<HandledKind, string> = {
  approve: "Approved",
  reply: "Replied",
  changes: "Requested changes",
  comment: "Commented",
  merge: "Merged",
  close: "Closed",
};

export function postedLabel(item: Pick<PrItem, "posted">, entry: HandledMark | null): string | null {
  if (entry?.kind) return POSTED_LABEL[entry.kind];
  return item.posted ? "Posted" : null;
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
    .map((action) => ({ action, label: INBOX_ACTION_LABEL[action], items: sorted.filter((item) => inNeedsYou(item) && inboxAction(item) === action) }))
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

export type ListView = "needs-you" | "all-open";

const LIST_ROOT: Record<ListView, string> = { "needs-you": "/inbox", "all-open": "/open" };

export function listRoot(view: ListView): string {
  return LIST_ROOT[view];
}

export function listHref(view: ListView, item: Pick<PrItem, "repo" | "number">): string {
  return `${LIST_ROOT[view]}/${item.repo}/${item.number ?? ""}`;
}

export function repoOf(key: string): string {
  return key.slice(0, key.lastIndexOf("#"));
}

export type OpenItem = { item: PrItem; handled: HandledMark | null };

/** A pending approval still needs a person after its repository's triage is turned off. */
export function allOpen(open: OpenItem[], enabled: ReadonlySet<string>): OpenItem[] {
  return open.filter((entry) => enabled.has(entry.item.repo) || entry.item.pendingApprovalId !== null);
}

function needsYouEntry(entry: OpenItem): boolean {
  return entry.item.pendingApprovalId !== null || entry.handled === null;
}

/** All open less what you acted on, before `inNeedsYou` sets aside what waits on others. */
export function needsYou(open: OpenItem[], enabled: ReadonlySet<string>): OpenItem[] {
  return allOpen(open, enabled).filter(needsYouEntry);
}

/** Every open pull request outside Needs you, so the two together are All open. */
export function waitingOnOthers(open: OpenItem[], enabled: ReadonlySet<string>): OpenItem[] {
  return allOpen(open, enabled).filter((entry) => !needsYouEntry(entry) || !inNeedsYou(entry.item));
}

export function listCounts(open: OpenItem[], enabled: ReadonlySet<string>): Record<ListView, number> {
  return {
    "needs-you": needsYou(open, enabled).filter((entry) => inNeedsYou(entry.item)).length,
    "all-open": allOpen(open, enabled).length,
  };
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
