import type { PrItem, QueueState } from "./hub-api.ts";
import { priorityRank } from "./triage-view.ts";

export type InboxAction = "decide" | "review" | "unblock" | "duplicate" | "merge";

export const INBOX_ACTION_ORDER: InboxAction[] = ["decide", "review", "unblock", "duplicate", "merge"];

export const INBOX_ACTION_LABEL: Record<InboxAction, string> = {
  decide: "Decide",
  review: "Review",
  unblock: "Unblock",
  duplicate: "Close duplicates",
  merge: "Merge",
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

export type PrimaryAction = "reply" | "comment" | "approve" | "changes" | "close" | "merge";

const PRIMARY_LABEL: Record<PrimaryAction, string> = {
  reply: "Post reply",
  comment: "Comment",
  approve: "Approve",
  changes: "Request changes",
  close: "Close as duplicate",
  merge: "Merge",
};

const ROW_LABEL: Record<PrimaryAction, string> = {
  reply: "Reply",
  comment: "Comment",
  approve: "Approve",
  changes: "Request changes",
  close: "Close",
  merge: "Merge",
};

/** The pile a pull request lands in; null means it waits on someone else and sits under the fold. */
export function inboxAction(item: PrItem): InboxAction | null {
  if (item.canClose) return "duplicate";
  switch (item.state) {
    case "needs-decision":
      return "decide";
    case "awaiting-review":
      return "review";
    case "blocked":
      return "unblock";
    case "ready":
      return "merge";
    default:
      return null;
  }
}

export function primaryAction(item: PrItem, action: InboxAction | null): PrimaryAction | null {
  switch (action) {
    case null:
      return item.comment ? "reply" : null;
    case "decide":
      return item.comment ? "reply" : "comment";
    case "review":
      return "approve";
    case "unblock":
      return "changes";
    case "duplicate":
      return "close";
    case "merge":
      return "merge";
  }
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

export type InboxView = { groups: InboxGroup[]; waiting: PrItem[] };

export function groupInbox(items: PrItem[]): InboxView {
  const sorted = [...items].sort(compareInboxItems);
  const groups = INBOX_ACTION_ORDER
    .map((action) => ({ action, label: INBOX_ACTION_LABEL[action], items: sorted.filter((item) => inboxAction(item) === action) }))
    .filter((group) => group.items.length > 0);
  return { groups, waiting: sorted.filter((item) => inboxAction(item) === null) };
}

export function matchesQuery(item: PrItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${item.title ?? ""} #${item.number ?? ""} ${item.repo} ${item.author ?? ""} ${item.owner ?? ""}`.toLowerCase().includes(normalized);
}

export function inboxHref(item: Pick<PrItem, "repo" | "number">): string {
  return `/inbox/${item.repo}/${item.number ?? ""}`;
}

export function confidenceText(item: Pick<PrItem, "confidence">): string | null {
  return item.confidence === null ? null : `${Math.round(item.confidence * 100)}% sure`;
}

export type InboxGrouping = "action" | "repo" | "owner";

export const INBOX_GROUPINGS: InboxGrouping[] = ["action", "repo", "owner"];

/** Hours under a day, else days, as the mockup writes ages. */
export function ageText(iso: string | null, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "";
  const hours = Math.max(0, Math.round((now - at) / 3_600_000));
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s@._-]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

export type InboxPile = { key: string; label: string; action: InboxAction | null; items: PrItem[] };

/** The actionable pull requests regrouped by repository or owner; the action pile order is kept inside each group. */
export function regroupInbox(view: InboxView, grouping: InboxGrouping): InboxPile[] {
  if (grouping === "action") return view.groups.map((group) => ({ key: group.action, label: group.label, action: group.action, items: group.items }));
  const ordered = view.groups.flatMap((group) => group.items);
  const keyOf = grouping === "repo" ? (item: PrItem) => item.repo : (item: PrItem) => item.owner ?? "Unassigned";
  const piles = new Map<string, PrItem[]>();
  for (const item of ordered) {
    const key = keyOf(item);
    piles.set(key, [...(piles.get(key) ?? []), item]);
  }
  return [...piles.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => ({ key, label: key, action: null, items }));
}
