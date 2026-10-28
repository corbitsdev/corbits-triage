import type { EffectContext } from "@intx/workflow";
import { ACTION_KINDS, marksWaiting, ownedLabels, parseCheckPack, repoSourceOf, trustedRequestOf, WAITING_LABEL, type RepoSource, type VerdictWord } from "@corbits/triage-contracts";
import type { MarkArgs, WaitingMark } from "../logic/render.js";

/** `mark` is absent when there is nothing to take off, so nothing is written either. */
export type UnreadyOutput = { unready: true; mark?: WaitingMark };

type Pull = { repo: string; number: number; onHead: string };

/** Ready never stands on a head triage has not checked; Not Ready and Needs Human Review stay until its verdict, so a push changes no label. */
function markArgs(source: RepoSource, pull: Pull, labels: Record<VerdictWord, string>, ci: boolean): MarkArgs {
  if (source === "bitbucket-datacenter") return { ...pull, labels: [], owned: [], build: { state: "INPROGRESS", description: WAITING_LABEL } };
  if (!ci) return { ...pull, labels: [], owned: [labels.pass] };
  return { ...pull, labels: [WAITING_LABEL], owned: ownedLabels(labels), keep: [labels.fail, labels.unsure] };
}

function mark(kind: "waiting" | "unready", source: RepoSource, pull: Pull, labels: Record<VerdictWord, string>, ci: boolean, appLogin: string | undefined): WaitingMark {
  const args = { ...markArgs(source, pull, labels, ci), ...(appLogin && { appLogin }) };
  return { effectId: `${kind}:${pull.repo.replace("/", "--")}:${pull.number}:${pull.onHead}`, repoSource: source, args };
}

function marks(source: RepoSource, automatic: readonly unknown[]): boolean {
  return marksWaiting(source, ACTION_KINDS.filter((kind) => automatic.includes(kind)));
}

/** The waiting marker on `headSha`, `Triage: Waiting for CI` only where the head has CI; none where triage does not write the verdict on this host. */
export function waitingMark(source: RepoSource, { repo, number, headSha }: { repo: string; number: number; headSha: string }, automatic: readonly unknown[], labels: Record<VerdictWord, string>, ci: boolean, appLogin: string | undefined): WaitingMark | undefined {
  if (!marks(source, automatic)) return undefined;
  return mark("waiting", source, { repo, number, onHead: headSha }, labels, ci, appLogin);
}

/**
 * A pull request mail from the hub's sender goes on to triage once Ready is off its head on GitHub; Bitbucket's build
 * status is per commit already. Any other mail goes on to triage as it is.
 */
export async function unready(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<UnreadyOutput> {
  const { request, trusted } = trustedRequestOf(input);
  if (!request || !trusted || request["kind"] !== "pr") return { unready: true };
  const source = repoSourceOf(request["repoSource"]);
  const { repo, prNumber, headSha, automatic } = request;
  const pack = parseCheckPack(request["pack"] ?? request["checkPack"]);
  if (typeof repo !== "string" || typeof prNumber !== "number" || typeof headSha !== "string" || !Array.isArray(automatic) || !pack) return { unready: true };
  if (!marks(source, automatic) || source !== "github") return { unready: true };
  const appLogin = typeof request["appLogin"] === "string" ? request["appLogin"] : undefined;
  return { unready: true, mark: mark("unready", source, { repo, number: prNumber, onHead: headSha }, pack.labels, false, appLogin) };
}
