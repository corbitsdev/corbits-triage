import type { PrItem, QueueState } from "./hub-api.ts";
import { priorityRank } from "./triage-view.ts";

export type InboxAction = "decide" | "review" | "unblock" | "duplicate" | "merge" | "failed";

export const INBOX_ACTION_ORDER: InboxAction[] = ["decide", "review", "unblock", "duplicate", "merge", "failed"];

export const INBOX_ACTION_LABEL: Record<InboxAction, string> = {
  decide: "Decide",
  review: "Review",
  unblock: "Unblock",
  duplicate: "Close duplicates",
  merge: "Merge",
  failed: "Failed",
};

export const INBOX_STATUS_LABEL: Record<QueueState, string> = {
  "needs-decision": "Needs your decision",
  "awaiting-review": "Waiting for review",
  "needs-author-update": "Waiting on author",
  blocked: "Blocked",
  ready: "Ready to merge",
  stale: "Rechecking",
  new: "Not triaged yet",
};

/** A running pull request says so; it keeps its previous verdict for grouping. */
export function inboxStatus(item: Pick<PrItem, "running" | "state">): string {
  return item.running ? "Running" : INBOX_STATUS_LABEL[item.state];
}

/** The row's one-line reason: the running status, else the verdict's first piece of evidence. */
export function rowWhy(item: Pick<PrItem, "running" | "state" | "evidence">): string | null {
  return item.running ? inboxStatus(item) : (item.evidence[0] ?? null);
}

export const UNASSIGNED = "Unassigned";

export type PrimaryAction = "reply" | "comment" | "approve" | "changes" | "close" | "merge" | "triage";

const PRIMARY_LABEL: Record<PrimaryAction, string> = {
  reply: "Post reply",
  comment: "Comment",
  approve: "Approve",
  changes: "Request changes",
  close: "Close as duplicate",
  merge: "Merge",
  triage: "Triage again",
};

const ROW_LABEL: Record<PrimaryAction, string> = {
  reply: "Reply",
  comment: "Comment",
  approve: "Approve",
  changes: "Request changes",
  close: "Close",
  merge: "Merge",
  triage: "Retry",
};

/** The pile a pull request lands in; null means it is still awaiting its first verdict and is only counted. */
export function inboxAction(item: PrItem): InboxAction | null {
  if (item.canClose) return "duplicate";
  switch (item.state) {
    case "needs-decision":
    case "stale":
      return "decide";
    case "awaiting-review":
      return "review";
    case "blocked":
    case "needs-author-update":
      return "unblock";
    case "ready":
      return "merge";
    case "new":
      return item.failure === null ? null : "failed";
  }
}

/** The author must act and the App already told them so; there is nothing left to send. */
export function isPostedToAuthor(item: PrItem): boolean {
  return item.state === "needs-author-update" && item.posted;
}

/** A comment only counts as a draft when it holds non-empty text; a degraded verdict's empty feedback is nothing to post. */
export function hasDraftComment(comment: string | null): boolean {
  return comment !== null && comment.trim() !== "";
}

export function primaryAction(item: PrItem, action: InboxAction | null): PrimaryAction | null {
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
    case "duplicate":
      return "close";
    case "merge":
      return "merge";
    case "failed":
      return "triage";
  }
}

/** A write that settles a pull request for now; merge and close settle it for good. */
export type HandledKind = Exclude<PrimaryAction, "triage">;

/** What the maintainer did to a pull request that is still handled; `kind` is null for an entry stored before kinds were recorded. */
export type HandledMark = { kind: HandledKind | null };

export type WaitsOn = "maintainer" | "author" | "ci" | "nobody";

const WAITS_ON_ORDER: WaitsOn[] = ["maintainer", "author", "ci", "nobody"];

export const WAITS_ON_LABEL: Record<WaitsOn, string> = {
  maintainer: "Waits on you",
  author: "Waits on author",
  ci: "Waits on CI",
  nobody: "Waits on nobody",
};

const AUTHOR_TURN: ReadonlySet<HandledKind | null> = new Set(["changes", "reply", "comment"]);

/** Who must act next, checked in order; `entry` is the pull request's handled mark, null while it is in Needs you. */
export function waitsOn(item: PrItem, entry: HandledMark | null): WaitsOn {
  if ((entry === null && inboxAction(item) !== null) || item.pendingApprovalId !== null) return "maintainer";
  if (item.draft === true || item.state === "needs-author-update" || (entry !== null && AUTHOR_TURN.has(entry.kind))) return "author";
  if (item.ci === "pending") return "ci";
  return "nobody";
}

const POSTED_LABEL: Record<HandledKind, string> = {
  approve: "Approved",
  reply: "Replied",
  changes: "Requested changes",
  comment: "Commented",
  merge: "Merged",
  close: "Closed",
};

/** What is on GitHub for the pull request: what the maintainer did, else the verdict's reply. */
export function postedLabel(item: Pick<PrItem, "posted">, entry: HandledMark | null): string | null {
  if (entry?.kind) return POSTED_LABEL[entry.kind];
  return item.posted ? "Posted" : null;
}

export function primaryLabel(action: PrimaryAction): string {
  return PRIMARY_LABEL[action];
}

export function rowActionLabel(action: PrimaryAction): string {
  return ROW_LABEL[action];
}

function waitingSince(item: PrItem): number {
  return item.waitingSince ? Date.parse(item.waitingSince) : Number.MAX_SAFE_INTEGER;
}

/** Priority first, then humans first, then whoever has waited longest. */
export function compareInboxItems(a: PrItem, b: PrItem): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  if (a.needsHuman !== b.needsHuman) return a.needsHuman ? -1 : 1;
  return waitingSince(a) - waitingSince(b);
}

export type InboxGroup = { action: InboxAction; label: string; items: PrItem[] };

/** `awaiting` counts the pull requests with no verdict and no failed run in repositories that can be triaged; they are not rows. */
export type InboxView = { groups: InboxGroup[]; awaiting: number };

/** `ready` names the repositories that are enabled and set up; no other repository's pull requests can be triaged. */
export function groupInbox(items: PrItem[], ready: ReadonlySet<string>): InboxView {
  const sorted = [...items].sort(compareInboxItems);
  const groups = INBOX_ACTION_ORDER
    .map((action) => ({ action, label: INBOX_ACTION_LABEL[action], items: sorted.filter((item) => inboxAction(item) === action) }))
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

/** Needs you is the inbox proper; All open lists every open pull request with who it waits on. */
export type ListView = "needs-you" | "all-open";

const LIST_ROOT: Record<ListView, string> = { "needs-you": "/inbox", "all-open": "/open" };

export function listRoot(view: ListView): string {
  return LIST_ROOT[view];
}

export function listHref(view: ListView, item: Pick<PrItem, "repo" | "number">): string {
  return `${LIST_ROOT[view]}/${item.repo}/${item.number ?? ""}`;
}

/** An open pull request with its handled mark, held or sent; null while it is in Needs you. */
export type OpenItem = { item: PrItem; handled: HandledMark | null };

/** The rail counts: Needs you counts its rows, so not pull requests still awaiting their first verdict; All open counts everything open. */
export function listCounts(open: OpenItem[]): Record<ListView, number> {
  return {
    "needs-you": open.filter((entry) => entry.handled === null && inboxAction(entry.item) !== null).length,
    "all-open": open.length,
  };
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

/** The actionable pull requests regrouped by repository or owner; the action pile order is kept inside each group. */
export function regroupInbox(view: InboxView, grouping: InboxGrouping): InboxPile[] {
  if (grouping === "action") return view.groups.map((group) => ({ key: group.action, label: group.label, action: group.action, items: group.items }));
  const ordered = view.groups.flatMap((group) => group.items);
  return pileBy(ordered, grouping === "repo" ? (item) => item.repo : ownerOf).map(({ key, items }) => ({ key, label: key, action: null, items }));
}

export type OpenPile = { key: string; label: string; items: OpenItem[] };

/** Every open pull request by repository, who it waits on, or owner, in inbox order inside each group. */
export function groupOpen(open: OpenItem[], grouping: OpenGrouping): OpenPile[] {
  const sorted = [...open].sort((a, b) => compareInboxItems(a.item, b.item));
  if (grouping === "waits") {
    return WAITS_ON_ORDER
      .map((waits) => ({ key: waits, label: WAITS_ON_LABEL[waits], items: sorted.filter((entry) => waitsOn(entry.item, entry.handled) === waits) }))
      .filter((pile) => pile.items.length > 0);
  }
  const keyOf = grouping === "repo" ? (entry: OpenItem) => entry.item.repo : (entry: OpenItem) => ownerOf(entry.item);
  return pileBy(sorted, keyOf).map(({ key, items }) => ({ key, label: key, items }));
}
