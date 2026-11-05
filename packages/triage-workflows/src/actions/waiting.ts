import type { EffectContext } from "@intx/workflow";
import { ownedLabels, parseCheckPack, RETIRED_LABELS, repoSourceOf, trustedRequestOf, WAITING_STATUS, type Awaits, type KeptVerdict, type RepoSource, type VerdictLabels } from "@corbits/triage-contracts";
import { progressComment, type WaitingMark } from "../logic/render.js";

type Head = { repo: string; number: number; headSha: string };

/** `mark` is absent where triage does not label on GitHub, so nothing is written. */
export type UnreadyOutput = { unready: true; mark?: WaitingMark };

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
 * What a pull request that merged or closed on `headSha` before its verdict shows: where triage comments, its comment
 * says Triage did not finish, and on GitHub Triage's labels come off. Without its comment a verdict on the head cannot be
 * told from a stale one, so only the retired labels come off, wherever the workspace grants it any posting.
 */
export function closedMark(source: RepoSource, { repo, number, headSha, merged }: Head & { merged: boolean }, automatic: readonly unknown[], labels: VerdictLabels | undefined, appLogin: string | undefined): WaitingMark | undefined {
  const comment = automatic.includes("comment");
  if (!comment && (source !== "github" || automatic.length === 0)) return undefined;
  const owned = source === "github" ? closedOwned(comment, labels) : [];
  const args = { repo, number, onHead: headSha, labels: [], owned, closedOut: { merged, comment }, ...(appLogin && { appLogin }) };
  return { effectId: `closed:${repo.replace("/", "--")}:${number}:${headSha}`, repoSource: source, args };
}

function closedOwned(comment: boolean, labels: VerdictLabels | undefined): readonly string[] {
  return comment ? ownedLabels(labels) : RETIRED_LABELS;
}

/**
 * The first pass on a GitHub head takes the earlier verdict's label off before facts; a later event on the same head
 * writes no label, and the head's own verdict puts its label on.
 */
export async function unready(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<UnreadyOutput> {
  const { request, trusted } = trustedRequestOf(input);
  if (!request || !trusted || request["kind"] !== "pr" || request["newHead"] !== true || repoSourceOf(request["repoSource"]) !== "github") return { unready: true };
  const { repo, prNumber, headSha, automatic } = request;
  const pack = parseCheckPack(request["pack"] ?? request["checkPack"]);
  if (typeof repo !== "string" || typeof prNumber !== "number" || typeof headSha !== "string" || !Array.isArray(automatic) || !automatic.includes("labels") || !pack?.labels) return { unready: true };
  const appLogin = typeof request["appLogin"] === "string" ? request["appLogin"] : undefined;
  const args = { repo, number: prNumber, onHead: headSha, labels: [], owned: Object.values(pack.labels), ...(appLogin && { appLogin }) };
  return { unready: true, mark: { effectId: `unready:${repo.replace("/", "--")}:${prNumber}:${headSha}`, repoSource: "github", args } };
}
