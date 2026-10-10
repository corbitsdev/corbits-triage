import type { ActionKind } from "@corbits/triage-contracts";
import { strings, type DoRef, type DoRun, type PrItem, type SuggestedAction } from "./hub-api.ts";

/** Keyed by the Do's effect id; `running` while the hub is writing it, and `error` is why its last attempt failed. */
export type PendingDo = {
  key: string;
  label: string;
  actionId: string;
  kind: ActionKind;
  reason: string;
  ref: DoRef;
  running: boolean;
  error: string | null;
};

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
    case "close":
      return "Close";
    case "agent":
      return null;
  }
}

/** The verdict's resolved Dos the hub can run, in the order the pack lists them. */
function offeredDos(item: PrItem): PendingDo[] {
  const { repo, number, runId } = item;
  if (number === null || runId === null) return [];
  const out: PendingDo[] = [];
  for (const action of item.actions) {
    // A flagged duplicate already offers its own close, with the reply and labels.
    if (action.kind === "close" && item.canClose) continue;
    const text = label(action, repo);
    if (text === null) continue;
    const ref = { runId, repo, number, actionId: action.id, branch: action.branch, index: action.index };
    out.push({ key: action.effectId, label: text, actionId: action.id, kind: action.kind, reason: action.reason, ref, running: false, error: null });
  }
  return out;
}

/** Dos the hub has not settled and that are not held for Undo, with the hub's state of each. */
export function pendingDos(item: PrItem, runs: DoRun[], held: ReadonlySet<string>): PendingDo[] {
  const byEffect = new Map(runs.map((run) => [run.effectId, run]));
  const out: PendingDo[] = [];
  for (const pending of offeredDos(item)) {
    const run = byEffect.get(pending.key);
    if (held.has(pending.key) || run?.status === "done" || run?.status === "satisfied") continue;
    out.push({ ...pending, running: run?.status === "running", error: run?.status === "failed" ? run.error : null });
  }
  return out;
}

/** The pack's close stands in for the plain one, so only one Close is offered. */
export function offersClose(item: PrItem): boolean {
  return offeredDos(item).some((pending) => pending.kind === "close");
}

export type DoGroup = { actionId: string; reason: string; dos: PendingDo[] };

/** One pack action's Dos share the branch it took, and so its reason. */
export function doGroups(dos: PendingDo[]): DoGroup[] {
  const groups = new Map<string, DoGroup>();
  for (const pending of dos) {
    const group = groups.get(pending.actionId);
    if (group === undefined) groups.set(pending.actionId, { actionId: pending.actionId, reason: pending.reason, dos: [pending] });
    else group.dos.push(pending);
  }
  return [...groups.values()];
}
