import type { EffectContext } from "@intx/workflow";
import { ACTION_KINDS, isFromTriageSender, marksWaiting, ownedLabels, repoSourceOf, triggerRequestOf, WAITING_KIND, WAITING_LABEL, type RepoSource } from "@corbits/triage-contracts";
import { packFromInput } from "../logic/checks.js";

/** The mirror tool's arguments for the waiting marker: the label on GitHub, the build status on Bitbucket Data Center. */
type MarkArgs = { repo: string; number: number; onHead: string; labels: string[]; owned: readonly string[]; build?: { state: "INPROGRESS"; description: string } };

/** `effectId` names the marker on its head; the write itself is a no-op where the head already shows it, and skipped once the head moved. */
export type WaitingMark = { effectId: string; repoSource: RepoSource; args: MarkArgs };

/** `mark` is absent when triage does not write the verdict on this host, so nothing is written either. */
export type WaitingOutput = { waiting: false } | { waiting: true; mark?: WaitingMark };

function markArgs(source: RepoSource, pull: { repo: string; number: number; onHead: string }, owned: readonly string[]): MarkArgs {
  if (source === "bitbucket-datacenter") return { ...pull, labels: [], owned: [], build: { state: "INPROGRESS", description: WAITING_LABEL } };
  return { ...pull, labels: [WAITING_LABEL], owned };
}

/** The waiting marker on `headSha`; none where triage does not write the verdict on this host. */
export function waitingMark(source: RepoSource, { repo, number, headSha }: { repo: string; number: number; headSha: string }, automatic: readonly unknown[], owned: readonly string[]): WaitingMark | undefined {
  if (!marksWaiting(source, ACTION_KINDS.filter((kind) => automatic.includes(kind)))) return undefined;
  const effectId = `waiting:${repo.replace("/", "--")}:${number}:${headSha}`;
  return { effectId, repoSource: source, args: markArgs(source, { repo, number, onHead: headSha }, owned) };
}

/** A waiting mail from the hub's sender marks its head as held for CI and triages nothing; any other mail goes on to triage. */
export async function waiting(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<WaitingOutput> {
  const request = triggerRequestOf(input);
  if (request?.["kind"] !== WAITING_KIND || !isFromTriageSender(input)) return { waiting: false };
  const { repo, prNumber, headSha, automatic } = request;
  const pack = packFromInput(request["pack"]);
  if (typeof repo !== "string" || typeof prNumber !== "number" || typeof headSha !== "string" || !Array.isArray(automatic) || !pack) return { waiting: true };
  const mark = waitingMark(repoSourceOf(request["repoSource"]), { repo, number: prNumber, headSha }, automatic, ownedLabels(pack.labels));
  return mark ? { waiting: true, mark } : { waiting: true };
}
