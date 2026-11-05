import { ownedLabels, WAITING_STATUS, type Awaits, type KeptVerdict, type RepoSource, type VerdictWord } from "@corbits/triage-contracts";
import { progressComment, type WaitingMark } from "../logic/render.js";

type Head = { repo: string; number: number; headSha: string };

/**
 * The waiting marker on `headSha` while its verdict waits for `awaits`: the in-progress comment naming them where triage
 * comments, and on Bitbucket Data Center the head's status while it waits for CI; none where triage writes neither.
 * Labels stay as the last verdict left them. With `keepVerdict`, the host keeps that verdict, under that policy, where
 * it is already posted on the head rather than writing this over it. `known` is what the comment already shows of the verdict.
 */
export function waitingMark(source: RepoSource, { repo, number, headSha }: Head, awaits: readonly Awaits[], automatic: readonly unknown[], appLogin: string | undefined, keepVerdict?: Omit<KeptVerdict, "head">, known?: string): WaitingMark | undefined {
  const comment = automatic.includes("comment") ? { comment: progressComment(awaits, known), ...(keepVerdict && { keepVerdict }) } : {};
  const status = source === "bitbucket-datacenter" && awaits.includes("ci") ? { status: WAITING_STATUS, statusHead: headSha } : {};
  if (!("comment" in comment) && !("status" in status)) return undefined;
  const args = { repo, number, onHead: headSha, labels: [], owned: [], ...status, ...comment, ...(appLogin && { appLogin }) };
  return { effectId: `waiting:${repo.replace("/", "--")}:${number}:${headSha}:${awaits.join("+")}`, repoSource: source, args };
}

/**
 * What a pull request that merged or closed on `headSha` before its verdict shows where triage comments: its comment
 * says Triage did not finish, and Triage's labels come off where it labels. Without its comment a verdict on the head
 * cannot be told from a stale one, so nothing is written.
 */
export function closedMark(source: RepoSource, { repo, number, headSha, merged }: Head & { merged: boolean }, automatic: readonly unknown[], labels: Record<VerdictWord, string>, appLogin: string | undefined): WaitingMark | undefined {
  const comment = automatic.includes("comment");
  if (!comment) return undefined;
  const owned = source === "github" && automatic.includes("labels") ? ownedLabels(labels) : [];
  const args = { repo, number, onHead: headSha, labels: [], owned, closedOut: { merged, comment }, ...(appLogin && { appLogin }) };
  return { effectId: `closed:${repo.replace("/", "--")}:${number}:${headSha}`, repoSource: source, args };
}
