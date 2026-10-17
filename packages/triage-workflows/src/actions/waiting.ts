import type { EffectContext } from "@intx/workflow";
import { ACTION_KINDS, isFromTriageSender, marksWaiting, ownedLabels, repoSourceOf, triggerRequestOf, WAITING_KIND, WAITING_LABEL, type RepoSource } from "@corbits/triage-contracts";
import { packFromInput } from "../logic/checks.js";

/** The mirror tool's arguments for the waiting marker: the label on GitHub, the build status on Bitbucket Data Center. */
type MarkArgs = { repo: string; number: number; onHead: string; labels: string[]; owned: string[]; build?: { state: "INPROGRESS"; description: string } };

/** `effectId` names the marker on its head; the write itself is a no-op where the head already shows it, and skipped once the head moved. */
export type WaitingMark = { effectId: string; repoSource: RepoSource; args: MarkArgs };

/** `mark` is absent when triage does not write the verdict on this host, so nothing is written either. */
export type WaitingOutput = { waiting: false } | { waiting: true; mark?: WaitingMark };

function markArgs(source: RepoSource, pull: { repo: string; number: number; onHead: string }, owned: string[]): MarkArgs {
  if (source === "bitbucket-datacenter") return { ...pull, labels: [], owned: [], build: { state: "INPROGRESS", description: WAITING_LABEL } };
  return { ...pull, labels: [WAITING_LABEL], owned };
}

/** A waiting mail from the hub's sender marks its head as held for CI and triages nothing; any other mail goes on to triage. */
export async function waiting(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<WaitingOutput> {
  const request = triggerRequestOf(input);
  if (request?.["kind"] !== WAITING_KIND || !isFromTriageSender(input)) return { waiting: false };
  const { repo, prNumber, headSha, automatic } = request;
  const pack = packFromInput(request["pack"]);
  if (typeof repo !== "string" || typeof prNumber !== "number" || typeof headSha !== "string" || !Array.isArray(automatic) || !pack) return { waiting: true };
  const source = repoSourceOf(request["repoSource"]);
  if (!marksWaiting(source, ACTION_KINDS.filter((kind) => automatic.includes(kind)))) return { waiting: true };
  const effectId = `waiting:${repo.replace("/", "--")}:${prNumber}:${headSha}`;
  return { waiting: true, mark: { effectId, repoSource: source, args: markArgs(source, { repo, number: prNumber, onHead: headSha }, ownedLabels(pack.labels)) } };
}
