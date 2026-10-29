import type { EffectContext } from "@intx/workflow";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { repoSourceOf, verdictStatus, type ActionKind } from "@corbits/triage-contracts";
import { isRecord } from "@corbits/common";
import { asText } from "../logic/extract.js";
import { call, data, hostWrite, toolName, type HostWrite } from "../logic/host.js";
import type { Verdict, WaitingMark } from "../logic/render.js";
import { decidesDos } from "../logic/settled.js";
import type { UnreadyOutput } from "./waiting.js";

const MIRRORED_KINDS: readonly ActionKind[] = ["comment", "labels", "approve", "request-changes"];

/** `kept` when the host kept a verdict already on the head rather than writing a progress comment over it. */
export type MirrorOutcome = { call: string; ok: boolean; error?: string; changeRequestsKept?: string; unchanged?: string; skipped?: string; kept?: "verdict" };
/** Why a verdict was not posted: it could not be decided, it waits on the host's checks, it carries nothing to post, or the pr-triage role is granted no write. */
export type NotPostedReason = "stale" | "waiting" | "no_request" | "no_grants";
export type MirrorSkip = { call: string; skipped: true; reason: NotPostedReason };
export type MirrorOutput = { results: Array<MirrorOutcome | MirrorSkip> } | MirrorOutcome | MirrorSkip | { skipped: true; reason?: string };

/** An evaluate output: a batch's verdicts as `items`, or the one verdict itself. */
export function verdictsOf(input: Record<string, unknown>): { verdicts: Verdict[]; batch: boolean } {
  return Array.isArray(input.items)
    ? { verdicts: input.items as Verdict[], batch: true }
    : { verdicts: [input as unknown as Verdict], batch: false };
}

/**
 * A settled head that may not be approved takes back the approve Do's approvals, of it or earlier heads, in a pack that approves;
 * one with nothing left for the author to fix takes back the request-changes Do's requests, in a pack that requests changes.
 */
function dismissals(v: Verdict) {
  const settled = v.headSha !== null && decidesDos(v);
  return { ...(settled && v.approvable === false && { notReadyHead: v.headSha }), ...(settled && v.changesWanted === false && { fixedHead: v.headSha }) };
}

/** Why the mirror writes nothing for the verdict; none when it writes its marker, the status Bitbucket Data Center always shows, what the pr-triage role is granted, or what an earlier Do left to take back. */
function notPosted(v: Verdict): NotPostedReason | undefined {
  if (v.mark !== undefined) return undefined;
  if (v.mirror !== true) return "stale";
  if (v.waiting) return "waiting";
  if (!v.request) return "no_request";
  if (!Array.isArray(v.automatic)) return "no_grants";
  if (repoSourceOf(v.repoSource) === "bitbucket-datacenter" && v.headSha !== null) return undefined;
  if (MIRRORED_KINDS.some((kind) => v.automatic.includes(kind)) || Object.keys(dismissals(v)).length > 0) return undefined;
  return "no_grants";
}

/** The verdict's status on its own head, which a newer head read when it is written must never take. */
function headStatus(v: Verdict) {
  if (v.headSha === null) return {};
  return { status: verdictStatus(v.verdict, v.checks.filter((c) => c.result === "fail").map((c) => c.check)), statusHead: v.headSha };
}

export function mirrorCallId(repo: string, number: number): string {
  return `mirror:${repo.replace("/", "--")}:${number}`;
}

/** A host error, or each write the mirror tool names failed while the others went through. */
function errorOf(r: ToolResult, failed: unknown): string | undefined {
  if (r.isError) return asText(r.content);
  if (!isRecord(failed)) return undefined;
  return Object.entries(failed).map(([write, error]) => `${write}: ${String(error)}`).join("; ");
}

function outcome(r: ToolResult): MirrorOutcome {
  const { changeRequestsKept, unchanged, skipped, failed, kept: verdictKept } = data<{ changeRequestsKept?: unknown; unchanged?: unknown; skipped?: unknown; failed?: unknown; kept?: unknown }>(r) ?? {};
  const error = errorOf(r, failed);
  return {
    call: r.callId,
    ok: error === undefined,
    ...(error !== undefined && { error }),
    ...(typeof changeRequestsKept === "string" ? { changeRequestsKept } : {}),
    ...(typeof unchanged === "string" ? { unchanged } : {}),
    ...(typeof skipped === "string" ? { skipped } : {}),
    ...(verdictKept === "verdict" && { kept: verdictKept }),
  };
}

function markCall(mark: WaitingMark): ToolCall {
  return call(toolName(mark.repoSource, "mirror_auto"), mark.args, mark.effectId);
}

function mirrorCall(v: Verdict): ToolCall {
  const r = v.request;
  const source = repoSourceOf(v.repoSource);
  const labels = v.automatic.includes("labels") ? { labels: r.labels, owned: r.owned } : { labels: [], owned: [] };
  const comment = v.automatic.includes("comment") ? { comment: r.comment, ...(r.header && { header: r.header }) } : {};
  const status = source === "bitbucket-datacenter" ? headStatus(v) : {};
  const appLogin = v.appLogin ? { appLogin: v.appLogin } : {};
  return call(toolName(source, "mirror_auto"), { repo: r.repo, number: r.number, ...labels, ...comment, ...status, ...dismissals(v), ...appLogin }, mirrorCallId(v.repo, v.number));
}

/**
 * Writes triage's labels when the pr-triage role holds labels and its reply when it holds comment; a host without labels
 * shows the verdict as a status on the head whatever the role holds, since it reports the verdict and acts on nothing. It takes back what earlier approve and request-changes Dos left
 * standing; the portal offers the rest. An unready output, and a verdict that waits on the host's checks, writes only its marker.
 */
export async function mirrorVerdicts(input: unknown, write: HostWrite): Promise<MirrorOutput> {
  if (!isRecord(input)) return { skipped: true, reason: "mirror: input is not JSON" };
  if (input.unready === true) {
    const { mark } = input as UnreadyOutput;
    if (!mark) return { skipped: true };
    return outcome(await write(mark.repoSource, markCall(mark)));
  }
  const { verdicts, batch } = verdictsOf(input);
  async function written(v: Verdict): Promise<MirrorOutcome | MirrorSkip> {
    const reason = notPosted(v);
    if (reason) return { call: mirrorCallId(v.repo, v.number), skipped: true, reason };
    if (v.mark) return outcome(await write(v.mark.repoSource, markCall(v.mark)));
    return outcome(await write(repoSourceOf(v.repoSource), mirrorCall(v)));
  }
  const outcomes = await Promise.all(verdicts.map(written));
  return batch ? { results: outcomes } : outcomes[0]!;
}

/** Writes a marker alone, as a manager's in-progress comment. */
export async function writeMark(mark: WaitingMark, ctx: EffectContext): Promise<MirrorOutcome> {
  return outcome(await hostWrite(ctx)(mark.repoSource, markCall(mark)));
}

export async function mirror(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<MirrorOutput> {
  return mirrorVerdicts(input, hostWrite(ctx));
}
