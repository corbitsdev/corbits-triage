import type { ActionKind, VerdictWord } from "@corbits/triage-contracts";
import { strings, type HeldDoRef, type PrItem, type SuggestedAction } from "./hub-api.ts";

/** `sentKey` also names the status it had when approved, so a later failure offers it again. */
export type PendingDo = { key: string; sentKey: string; label: string; list: VerdictWord; kind: ActionKind; reason: string; ref: HeldDoRef; error: string | null };

/** Resolution keeps only team slugs, and only the repository owner's teams can review. */
function teamName(slug: string, repo: string): string {
  return `@${repo.split("/", 1)[0]}/${slug}`;
}

const PREVIEW_MAX = 40;

/** A held comment or change request posts its own text, not Triage's drafted feedback, so its button names what it posts. */
function preview(body: string): string {
  const line = body.trim().split("\n", 1)[0];
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX).trimEnd()}…` : line;
}

function label(action: SuggestedAction, repo: string): string | null {
  const { kind, target } = action;
  if ("unresolved" in target) return null;
  switch (kind) {
    case "labels": {
      const labels = strings(target.labels);
      if (labels.length === 0) return null;
      return `Add ${labels.length === 1 ? "label" : "labels"} ${labels.join(", ")}`;
    }
    case "assign": {
      const assignees = strings(target.users);
      return assignees.length ? `Assign ${assignees.join(", ")}` : null;
    }
    case "request-review": {
      const reviewers = [...strings(target.teams).map((slug) => teamName(slug, repo)), ...strings(target.users)];
      return reviewers.length ? `Request review from ${reviewers.join(", ")}` : null;
    }
    case "comment":
      return typeof target.body === "string" && target.body.trim() ? `Comment "${preview(target.body)}"` : null;
    case "approve":
      return "Approve";
    case "request-changes":
      return typeof target.body === "string" && target.body.trim() ? `Request changes "${preview(target.body)}"` : null;
    case "close":
      return "Close";
    case "merge":
      return "Merge";
  }
}

function awaitsApproval({ held, status }: SuggestedAction): boolean {
  return status === undefined ? held : status === "failed" || status === "skipped";
}

function sentKeyOf(action: SuggestedAction): string {
  return `${action.effectId}:${action.status ?? "held"}`;
}

/** Drops the Dos skipped in this browser or waiting on their approval to send, so the pull request holds only those left to decide. */
export function withoutDecidedDos(item: PrItem, hidden: ReadonlySet<string>, sent: ReadonlySet<string>): PrItem {
  return { ...item, actions: item.actions.filter((action) => !hidden.has(action.effectId) && !sent.has(sentKeyOf(action))) };
}

export function pendingDos(item: PrItem): PendingDo[] {
  const { repo, number, runId } = item;
  if (number === null || runId === null) return [];
  const out: PendingDo[] = [];
  for (const action of item.actions) {
    const text = awaitsApproval(action) ? label(action, repo) : null;
    if (text === null) continue;
    const ref = { runId, repo, number, effectId: action.effectId, kind: action.kind };
    // A merge may be approved off a Fail or Unsure list, and the card says so.
    const shown = action.kind === "merge" && action.list !== "pass" ? `${text} (the verdict was ${action.list}, not pass)` : text;
    out.push({ key: action.effectId, sentKey: sentKeyOf(action), label: shown, list: action.list, kind: action.kind, reason: action.reason, ref, error: action.error ?? null });
  }
  return out;
}

/** The pack's close stands in for the plain one, so only one Close is offered. */
export function offersClose(item: PrItem): boolean {
  return pendingDos(item).some((pending) => pending.kind === "close");
}

/** Only a held action waits on a person: the next run tries an unattended one again, and a refused one cannot run. */
export function holdsActionForYou(item: PrItem): boolean {
  return item.actions.some((action) => action.held && (action.status === undefined || action.status === "failed") && label(action, item.repo) !== null);
}

export type DoGroup = { list: VerdictWord; reason: string; dos: PendingDo[] };

export function doGroups(dos: PendingDo[]): DoGroup[] {
  const groups = new Map<VerdictWord, DoGroup>();
  for (const pending of dos) {
    const group = groups.get(pending.list);
    if (group === undefined) groups.set(pending.list, { list: pending.list, reason: pending.reason, dos: [pending] });
    else group.dos.push(pending);
  }
  return [...groups.values()];
}
