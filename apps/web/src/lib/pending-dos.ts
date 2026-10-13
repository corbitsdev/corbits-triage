import type { ActionKind, VerdictWord } from "@corbits/triage-contracts";
import { strings, type HeldDoRef, type PrItem, type SuggestedAction } from "./hub-api.ts";

/**
 * A Do waiting for approval, keyed by its effect id; `sentKey` also names the status it had when approved, so a later failure offers it again.
 * `error` is why its last run did not write it.
 */
export type PendingDo = { key: string; sentKey: string; label: string; list: VerdictWord; kind: ActionKind; reason: string; ref: HeldDoRef; error: string | null };

/** Resolution keeps only team slugs, and only the repository owner's teams can review. */
function teamName(slug: string, repo: string): string {
  return `@${repo.split("/", 1)[0]}/${slug}`;
}

/** Null when the step has nothing the hub can run: an unresolved target, an empty one, or an agent. */
function label(action: SuggestedAction, repo: string): string | null {
  const { kind, target } = action;
  if ("unresolved" in target) return null;
  switch (kind) {
    case "labels": {
      const labels = strings(target.labels);
      return labels.length ? `Add ${labels.length === 1 ? "label" : "labels"} ${labels.join(", ")}` : null;
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
      return typeof target.body === "string" && target.body.trim() ? "Comment" : null;
    case "approve":
      return "Approve";
    case "request-changes":
      return "Request changes";
    case "close":
      return "Close";
    case "agent":
      return null;
  }
}

/** A held Do, or one its run failed or could not write; a written one is done. */
function awaitsApproval({ held, status }: SuggestedAction): boolean {
  return status === undefined ? held : status === "failed" || status === "skipped";
}

/** The verdict's Dos waiting for a maintainer that the hub can run, in the order the policy lists them. */
function offeredDos(item: PrItem): PendingDo[] {
  const { repo, number, runId } = item;
  if (number === null || runId === null) return [];
  const out: PendingDo[] = [];
  for (const action of item.actions) {
    const text = awaitsApproval(action) ? label(action, repo) : null;
    if (text === null) continue;
    const ref = { runId, repo, number, effectId: action.effectId, kind: action.kind };
    const sentKey = `${action.effectId}:${action.status ?? "held"}`;
    out.push({ key: action.effectId, sentKey, label: text, list: action.list, kind: action.kind, reason: action.reason, ref, error: action.error ?? null });
  }
  return out;
}

/** Dos waiting for approval, less those hidden here or sent since the status they show. */
export function pendingDos(item: PrItem, hidden: ReadonlySet<string>, sent: ReadonlySet<string>): PendingDo[] {
  return offeredDos(item).filter((pending) => !hidden.has(pending.key) && !sent.has(pending.sentKey));
}

/** The pack's close stands in for the plain one, so only one Close is offered. */
export function offersClose(item: PrItem): boolean {
  return offeredDos(item).some((pending) => pending.kind === "close");
}

export type DoGroup = { list: VerdictWord; reason: string; dos: PendingDo[] };

/** One verdict list's Dos share its verdict, and so its reason. */
export function doGroups(dos: PendingDo[]): DoGroup[] {
  const groups = new Map<VerdictWord, DoGroup>();
  for (const pending of dos) {
    const group = groups.get(pending.list);
    if (group === undefined) groups.set(pending.list, { list: pending.list, reason: pending.reason, dos: [pending] });
    else group.dos.push(pending);
  }
  return [...groups.values()];
}
