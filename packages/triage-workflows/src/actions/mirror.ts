import type { EffectContext } from "@intx/workflow";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { repoSourceOf, ruleLabel, type ActionKind } from "@corbits/triage-contracts";
import { isRecord } from "@corbits/common";
import { asText } from "../logic/extract.js";
import { call, data, hostWrite, toolName, type HostWrite } from "../logic/host.js";
import type { Verdict } from "../logic/render.js";
import { decidesDos } from "../logic/settled.js";
import type { WaitingMark, WaitingOutput } from "./waiting.js";

const MIRRORED_KINDS: readonly ActionKind[] = ["comment", "labels", "approve", "request-changes"];

const BUILD_STATES = { pass: "SUCCESSFUL", fail: "FAILED", unsure: "INPROGRESS" } as const;
const BUILD_WORDS = { pass: "Pass", fail: "Fail", unsure: "Needs review" } as const;
const BUILD_DESCRIPTION_MAX = 255;

export type MirrorOutcome = { call: string; ok: boolean; error?: string; changeRequestsKept?: string; unchanged?: string; skipped?: string };
export type MirrorOutput = { results: MirrorOutcome[] } | MirrorOutcome | { skipped: true; reason?: string };

/** An evaluate output: a batch's verdicts as `items`, or the one verdict itself. */
export function verdictsOf(input: Record<string, unknown>): { verdicts: Verdict[]; batch: boolean } {
  return Array.isArray(input.items)
    ? { verdicts: input.items as Verdict[], batch: true }
    : { verdicts: [input as unknown as Verdict], batch: false };
}

/** A host without labels shows the verdict as a build status on the head; the rule labels it would carry name the failed rules in its description. */
function verdictBuild(v: Verdict) {
  const failed = v.checks.filter((c) => c.result === "fail").map((c) => ruleLabel(c.check));
  const description = failed.length ? `${BUILD_WORDS[v.verdict]}: ${failed.join(", ")}` : BUILD_WORDS[v.verdict];
  return { state: BUILD_STATES[v.verdict], description: description.slice(0, BUILD_DESCRIPTION_MAX) };
}

/**
 * A settled head that may not be approved takes back the approve Do's approvals, of it or earlier heads, in a pack that approves;
 * one with nothing left for the author to fix takes back the request-changes Do's requests, in a pack that requests changes.
 */
function dismissals(v: Verdict) {
  const settled = v.headSha !== null && decidesDos(v);
  return { ...(settled && v.approvable === false && { notReadyHead: v.headSha }), ...(settled && v.changesWanted === false && { fixedHead: v.headSha }) };
}

/** Whether the mirror writes anything for the verdict: what the pr-triage role is granted, or what an earlier Do left to take back. */
function mirrors(v: Verdict): boolean {
  if (v.mirror !== true || !v.request || !Array.isArray(v.automatic)) return false;
  if (v.waiting) return v.mark !== undefined;
  return MIRRORED_KINDS.some((kind) => v.automatic.includes(kind)) || Object.keys(dismissals(v)).length > 0;
}

function outcome(r: ToolResult): MirrorOutcome {
  const { changeRequestsKept: kept, unchanged, skipped } = data<{ changeRequestsKept?: unknown; unchanged?: unknown; skipped?: unknown }>(r) ?? {};
  return {
    call: r.callId,
    ok: !r.isError,
    ...(r.isError ? { error: asText(r.content) } : {}),
    ...(typeof kept === "string" ? { changeRequestsKept: kept } : {}),
    ...(typeof unchanged === "string" ? { unchanged } : {}),
    ...(typeof skipped === "string" ? { skipped } : {}),
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
  const build = source === "bitbucket-datacenter" && v.automatic.includes("comment") ? { build: verdictBuild(v) } : {};
  return call(toolName(source, "mirror_auto"), { repo: r.repo, number: r.number, ...labels, ...comment, ...build, ...dismissals(v) }, `mirror:${r.repo.replace("/", "--")}:${r.number}`);
}

/**
 * Writes triage's labels when the pr-triage role holds labels and its reply when it holds comment; a host without labels
 * writes the verdict build status with the comment. It takes back what earlier approve and request-changes Dos left
 * standing; the portal offers the rest. A waiting output writes only its marker.
 */
export async function mirrorVerdicts(input: unknown, write: HostWrite): Promise<MirrorOutput> {
  if (!isRecord(input)) return { skipped: true, reason: "mirror: input is not JSON" };
  if (typeof input.waiting === "boolean") {
    const { mark } = input as WaitingOutput;
    if (!mark) return { skipped: true };
    return outcome(await write(mark.repoSource, markCall(mark)));
  }
  const { verdicts, batch } = verdictsOf(input);
  const mirrored = verdicts.filter(mirrors);
  if (!mirrored.length) return { skipped: true };
  function written(v: Verdict) {
    if (v.mark) return write(v.mark.repoSource, markCall(v.mark));
    return write(repoSourceOf(v.repoSource), mirrorCall(v));
  }
  const outcomes = (await Promise.all(mirrored.map(written))).map(outcome);
  return batch ? { results: outcomes } : outcomes[0]!;
}

export async function mirror(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<MirrorOutput> {
  return mirrorVerdicts(input, hostWrite(ctx));
}
