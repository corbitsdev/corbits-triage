import type { ActionKind } from "@corbits/triage-contracts";
import { strings, type PrGithubWriteInput, type PrItem, type SuggestedAction } from "./hub-api.ts";

export type PendingDo = {
  key: string;
  label: string;
  actionId: string;
  kind: ActionKind;
  reason: string;
  request: PrGithubWriteInput;
};

type Pull = PrItem & { number: number };

/** Resolution keeps only team slugs, and only the repository owner's teams can review. */
function teamName(slug: string, repo: string): string {
  return `@${repo.split("/", 1)[0]}/${slug}`;
}

/** Null when the step has nothing the hub can run: an unresolved target, an empty one, or an agent. */
function request(action: SuggestedAction, item: Pull): { label: string; request: PrGithubWriteInput } | null {
  const { kind, target } = action;
  const { repo, number } = item;
  if ("unresolved" in target) return null;
  switch (kind) {
    case "labels": {
      const labels = strings(target.labels);
      if (!labels.length) return null;
      return { label: `Add ${labels.length === 1 ? "label" : "labels"} ${labels.join(", ")}`, request: { action: "labels", repo, number, labels } };
    }
    case "assign": {
      const assignees = strings(target.users);
      if (!assignees.length) return null;
      return { label: `Assign ${assignees.join(", ")}`, request: { action: "assign", repo, number, assignees } };
    }
    case "request-review": {
      const reviewers = strings(target.users);
      const teamReviewers = strings(target.teams);
      if (!reviewers.length && !teamReviewers.length) return null;
      return {
        label: `Request review from ${[...teamReviewers.map((slug) => teamName(slug, repo)), ...reviewers].join(", ")}`,
        request: { action: "request-review", repo, number, ...(reviewers.length ? { reviewers } : {}), ...(teamReviewers.length ? { teamReviewers } : {}) },
      };
    }
    case "comment": {
      const body = typeof target.body === "string" ? target.body : "";
      if (!body.trim()) return null;
      return { label: "Comment", request: { action: "comment", repo, number, body } };
    }
    // The same close the pane's own Close sends, so a pack's close behaves identically.
    case "close":
      return { label: "Close", request: { action: "close", repo, number, labels: item.labels, comment: item.comment ?? "" } };
    case "agent":
      return null;
  }
}

/** The verdict's resolved Dos the hub's action route can run, in the order the pack lists them. */
export function pendingDos(item: PrItem): PendingDo[] {
  if (item.number === null) return [];
  const pull = { ...item, number: item.number };
  const out: PendingDo[] = [];
  for (const [index, action] of item.actions.entries()) {
    // A flagged duplicate already offers its own close, with the reply and labels.
    if (action.kind === "close" && item.canClose) continue;
    const resolved = request(action, pull);
    if (resolved === null) continue;
    out.push({ key: `${action.id}/${index}`, actionId: action.id, kind: action.kind, reason: action.reason, ...resolved });
  }
  return out;
}

/** The pack's close stands in for the plain one, so only one Close is offered. */
export function offersClose(item: PrItem): boolean {
  return pendingDos(item).some((pending) => pending.kind === "close");
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

/** Dos held or sent to GitHub, by pull request key, for the verdict run that suggested them. */
export type RanDos = Record<string, { runId: string; keys: string[] }>;

function ranKeys(ran: RanDos | undefined, item: PrItem): string[] {
  const entry = ran?.[item.key];
  return entry !== undefined && entry.runId === item.runId ? entry.keys : [];
}

/** A newer verdict replaces the entry, so its Dos are offered afresh. */
function withKeys(ran: RanDos | undefined, item: PrItem, keys: string[]): RanDos {
  if (item.runId === null) return ran ?? {};
  return { ...ran, [item.key]: { runId: item.runId, keys } };
}

export function withRan(ran: RanDos | undefined, item: PrItem, key: string): RanDos {
  return withKeys(ran, item, [...ranKeys(ran, item), key]);
}

export function withoutRan(ran: RanDos | undefined, item: PrItem, key: string): RanDos {
  return withKeys(ran, item, ranKeys(ran, item).filter((ranKey) => ranKey !== key));
}

export function unranDos(item: PrItem, ran: RanDos): PendingDo[] {
  const done = ranKeys(ran, item);
  return pendingDos(item).filter((pending) => !done.includes(pending.key));
}
