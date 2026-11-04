import type { EffectContext } from "@intx/workflow";
import { ACTION_KINDS, marksWaiting, ownedLabels, parseCheckPack, repoSourceOf, trustedRequestOf, WAITING_LABELS, WAITING_STATUS, type Awaits, type KeptVerdict, type RepoSource, type VerdictWord } from "@corbits/triage-contracts";
import { progressComment, type MarkArgs, type WaitingMark } from "../logic/render.js";

/** `mark` is absent when there is nothing to take off, so nothing is written either. */
export type UnreadyOutput = { unready: true; mark?: WaitingMark };

type Pull = { repo: string; number: number; onHead: string };

/** Ready never stands on a head triage has not checked; Not Ready and Needs Human Review stay until its verdict, so a push changes no label. */
function markArgs(source: RepoSource, pull: Pull, labels: Record<VerdictWord, string>, waiting: readonly string[]): MarkArgs {
  if (source === "bitbucket-datacenter") return { ...pull, labels: [], owned: [], status: WAITING_STATUS, statusHead: pull.onHead };
  if (waiting.length === 0) return { ...pull, labels: [], owned: [labels.pass] };
  return { ...pull, labels: [...waiting], owned: ownedLabels(labels), keep: [labels.fail, labels.unsure] };
}

function marks(source: RepoSource, automatic: readonly unknown[]): boolean {
  return marksWaiting(source, ACTION_KINDS.filter((kind) => automatic.includes(kind)));
}

/** Every triage event on the request is a person's approval, so labels stay as they are. */
function approvalOnly(events: unknown): boolean {
  return Array.isArray(events) && events.length > 0 && events.every((event) => event === "approved");
}

/**
 * Whether the waiting marker writes labels, or Bitbucket Data Center's status, for `awaits`: where triage marks on this
 * host, except on an approval-only GitHub pass. Bitbucket's status names only CI.
 */
function marked(source: RepoSource, awaits: readonly Awaits[], automatic: readonly unknown[], events: readonly unknown[]): boolean {
  if (!marks(source, automatic)) return false;
  return source === "github" ? !approvalOnly(events) : awaits.includes("ci");
}

/**
 * The waiting marker on `headSha` while its verdict waits for `awaits`: the label of each, CI's only where the head has
 * checks, and the in-progress comment naming them where triage comments; none where triage writes neither. With
 * `keepVerdict`, the host keeps that verdict, under that policy, where it is already posted on the head rather than
 * writing this over it, labels included.
 */
export function waitingMark(source: RepoSource, { repo, number, headSha, checks, events = [] }: { repo: string; number: number; headSha: string; checks: string; events?: readonly unknown[] }, awaits: readonly Awaits[], automatic: readonly unknown[], labels: Record<VerdictWord, string>, appLogin: string | undefined, keepVerdict?: Omit<KeptVerdict, "head">): WaitingMark | undefined {
  const pull = { repo, number, onHead: headSha };
  const comment = automatic.includes("comment") ? { comment: progressComment(awaits), ...(keepVerdict && { keepVerdict }) } : {};
  const labelled = marked(source, awaits, automatic, events);
  if (!labelled && !("comment" in comment)) return undefined;
  const waiting = awaits.filter((awaited) => awaited !== "ci" || checks !== "none").map((awaited) => WAITING_LABELS[awaited]);
  const args = labelled ? markArgs(source, pull, labels, waiting) : { ...pull, labels: [], owned: [] };
  return { effectId: `waiting:${repo.replace("/", "--")}:${number}:${headSha}:${awaits.join("+")}`, repoSource: source, args: { ...args, ...comment, ...(appLogin && { appLogin }) } };
}

/**
 * What a pull request that merged or closed on `headSha` before its verdict shows: its comment says Triage did not
 * finish where triage comments, and Triage's labels come off where it labels; none where triage writes neither. Without
 * its comment a verdict on the head cannot be told from a stale one, so only the waiting label comes off.
 */
export function closedMark(source: RepoSource, { repo, number, headSha, merged }: { repo: string; number: number; headSha: string; merged: boolean }, automatic: readonly unknown[], labels: Record<VerdictWord, string>, appLogin: string | undefined): WaitingMark | undefined {
  const comment = automatic.includes("comment");
  let owned: readonly string[] = [];
  if (source === "github" && automatic.includes("labels")) owned = comment ? ownedLabels(labels) : Object.values(WAITING_LABELS);
  if (!comment && owned.length === 0) return undefined;
  const args = { repo, number, onHead: headSha, labels: [], owned, closedOut: { merged, comment }, ...(appLogin && { appLogin }) };
  return { effectId: `closed:${repo.replace("/", "--")}:${number}:${headSha}`, repoSource: source, args };
}

/**
 * A GitHub pull-request mail from the hub takes Ready off its head before facts, except when every triage event on the
 * request is `"approved"`, which leaves labels as they are. A push, open, synchronize, check, comment, catch-up, or any
 * mix still takes Ready off. Bitbucket writes nothing here. Any other mail goes on as it is.
 */
export async function unready(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<UnreadyOutput> {
  const { request, trusted } = trustedRequestOf(input);
  if (!request || !trusted || request["kind"] !== "pr") return { unready: true };
  const source = repoSourceOf(request["repoSource"]);
  const { repo, prNumber, headSha, automatic } = request;
  const pack = parseCheckPack(request["pack"] ?? request["checkPack"]);
  if (typeof repo !== "string" || typeof prNumber !== "number" || typeof headSha !== "string" || !Array.isArray(automatic) || !pack) return { unready: true };
  if (!marks(source, automatic) || source !== "github") return { unready: true };
  if (approvalOnly(request["events"])) return { unready: true };
  const appLogin = typeof request["appLogin"] === "string" ? request["appLogin"] : undefined;
  const args = { ...markArgs(source, { repo, number: prNumber, onHead: headSha }, pack.labels, []), ...(appLogin && { appLogin }) };
  return { unready: true, mark: { effectId: `unready:${repo.replace("/", "--")}:${prNumber}:${headSha}`, repoSource: source, args } };
}
