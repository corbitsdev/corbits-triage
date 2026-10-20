import type { EffectContext } from "@intx/workflow";
import { ACTION_KINDS, isFromTriageSender, marksWaiting, ownedLabels, repoSourceOf, triggerRequestOf, WAITING_KIND, WAITING_LABEL, type RepoSource, type VerdictWord } from "@corbits/triage-contracts";
import { packFromInput } from "../logic/checks.js";
import type { MarkArgs, WaitingMark } from "../logic/render.js";

/** `mark` is absent when triage does not write the verdict on this host, so nothing is written either. */
export type WaitingOutput = { waiting: boolean; mark?: WaitingMark };

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
 * A waiting mail from the hub's sender marks its head as held for CI and triages nothing. A pull request mail from it goes on
 * to triage once Ready is off its head on GitHub; Bitbucket's build status is per commit already. Any other mail goes on to triage.
 */
export async function waiting(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<WaitingOutput> {
  const request = triggerRequestOf(input);
  const held = request?.["kind"] === WAITING_KIND;
  if (!request || !isFromTriageSender(input) || (!held && request["kind"] !== "pr")) return { waiting: false };
  const source = repoSourceOf(request["repoSource"]);
  const { repo, prNumber, headSha, automatic } = request;
  const pack = packFromInput(request["pack"] ?? request["checkPack"]);
  if (typeof repo !== "string" || typeof prNumber !== "number" || typeof headSha !== "string" || !Array.isArray(automatic) || !pack) return { waiting: held };
  if (!marks(source, automatic) || (!held && source !== "github")) return { waiting: held };
  const pull = { repo, number: prNumber, onHead: headSha };
  const appLogin = typeof request["appLogin"] === "string" ? request["appLogin"] : undefined;
  if (held) return { waiting: true, mark: mark("waiting", source, pull, pack.labels, request["noCi"] !== true, appLogin) };
  return { waiting: false, mark: mark("unready", source, pull, pack.labels, false, appLogin) };
}
