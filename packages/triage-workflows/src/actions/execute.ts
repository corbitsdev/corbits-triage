import type { EffectContext } from "@intx/workflow";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { repoSourceOf, type RepoSource } from "@corbits/triage-contracts";
import type { DoInput, DoOutcome } from "@corbits/github-tool/do";
import { isRecord } from "@corbits/common";
import type { SuggestedAction, SuggestedDo } from "../logic/actions.js";
import { unrunnable } from "../logic/execute-do.js";
import { asText } from "../logic/extract.js";
import { call, data, hostWrite, type HostWrite } from "../logic/host.js";
import type { Verdict } from "../logic/render.js";
import { decidesDos } from "../logic/settled.js";
import type { ApprovalOutput } from "./approval.js";
import { verdictsOf } from "./mirror.js";

/** One Do's outcome; a failed or skipped unattended one is tried again by the next run. */
export type DoResult = { effectId: string; status: DoOutcome["status"] | "failed" | "skipped"; error?: string };

export type ExecuteOutput = { dos: DoResult[]; reason?: string };

/** Dos one run writes at most; the rest wait for the next run. */
export const MAX_DOS_PER_RUN = 10;
const NOT_SETTLED = "verdict not settled";
const OVER_CAP = `more than ${MAX_DOS_PER_RUN} unattended Dos in one run`;

/** The unattended action tool: the GitHub one keeps the name it was deployed with. */
const EXECUTE_TOOL: Record<RepoSource, string> = { github: "github_execute_do_auto", "bitbucket-datacenter": "bitbucket_datacenter_execute_action_auto" };

type AutomaticDo = { verdict: Verdict; step: SuggestedDo };

type QueuedDo = DoInput & { repoSource?: RepoSource; appLogin?: string };

function isDo(action: SuggestedAction): action is SuggestedDo {
  return "effectId" in action;
}

/** Only Dos whose kind the pr-triage role holds run unattended, and only those evaluate did not hold. */
function automaticDos(v: Verdict): AutomaticDo[] {
  if (!v.request || !Array.isArray(v.actions) || !Array.isArray(v.automatic)) return [];
  return v.actions.filter(isDo).filter((step) => step.held !== true && v.automatic.includes(step.kind)).map((step) => ({ verdict: v, step }));
}

function refusal({ verdict, step }: AutomaticDo): string | undefined {
  return verdict.headSha !== null && decidesDos(verdict) ? unrunnable(step) : NOT_SETTLED;
}

function doInput({ verdict, step }: AutomaticDo): QueuedDo {
  return { request: verdict.request, step: { effectId: step.effectId, headSha: verdict.headSha!, kind: step.kind, target: step.target }, ...(verdict.repoSource && { repoSource: verdict.repoSource }), ...(verdict.appLogin && { appLogin: verdict.appLogin }) };
}

/** The call id is the effect id, so each result names its Do. */
function doCall({ request, step, repoSource, appLogin }: QueuedDo): ToolCall {
  return call(EXECUTE_TOOL[repoSourceOf(repoSource)], { request, step, ...(appLogin && { appLogin }) }, step.effectId);
}

function outcome(tool: string, r: ToolResult): DoResult {
  if (r.isError) return { effectId: r.callId, status: "failed", error: asText(r.content) };
  const result = data<{ status?: DoResult["status"]; reason?: string }>(r);
  if (result?.status === "skipped" && typeof result.reason === "string") return { effectId: r.callId, status: "skipped", error: result.reason };
  if (result?.status === "done" || result?.status === "satisfied") return { effectId: r.callId, status: result.status };
  return { effectId: r.callId, status: "failed", error: `${tool} result is unreadable` };
}

/** Writes one Do at a time, so a run never floods a pull request. An approval's input is the one held Do to write. */
export async function executeDos(input: unknown, write: HostWrite): Promise<ExecuteOutput> {
  if (!isRecord(input)) return { dos: [], reason: "execute: input is not JSON" };
  const results: DoResult[] = [];
  const queue: QueuedDo[] = [];
  if (input.approved === true) {
    const approved = input as ApprovalOutput & { approved: true };
    if ("refused" in approved) results.push({ effectId: approved.effectId, status: "skipped", error: approved.refused });
    else queue.push(approved);
  } else {
    for (const d of verdictsOf(input).verdicts.flatMap(automaticDos)) {
      const refused = refusal(d);
      if (refused !== undefined) results.push({ effectId: d.step.effectId, status: "skipped", error: refused });
      else if (queue.length < MAX_DOS_PER_RUN) queue.push(doInput(d));
      else results.push({ effectId: d.step.effectId, status: "skipped", error: OVER_CAP });
    }
  }
  for (const queued of queue) {
    const written = doCall(queued);
    results.push(outcome(written.name, await write(repoSourceOf(queued.repoSource), written)));
  }
  return { dos: results };
}

export async function execute(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<ExecuteOutput> {
  return executeDos(input, hostWrite(ctx));
}
