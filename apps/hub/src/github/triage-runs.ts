// What the audit log and held Dos read from a pr-triage run's event log: the
// approval it carried out and the verdict it made for a pull request.
import { type } from "arktype";
import { APPROVE_DO_KIND, isFromTriageSender, triggerRequestOf } from "@corbits/triage-contracts";
import { asRecord } from "@corbits/common";
import { classifyTerminalEvent, type WorkflowRunEvent } from "@intx/hub-sessions";
import type { ApprovedDo } from "./verdict-record-store.js";
import { DoResult, doResultsOf, withResults } from "./verdict-row.js";

const INLINE_PREFIX = "inline:";

/** An approval run names no head; `approved` is set once it ended, empty when it wrote nothing. `principalId` is who approved. */
export type Approval = { repo: string; number: number; principalId?: string; approved?: ApprovedDo[] };
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The pull request an approval mail from the hub's sender names a Do of; pr-triage takes any other mail as no approval. */
function approvalOf(started: Record<string, unknown>): Approval | undefined {
  const mail = asRecord(started["trigger"])?.["payload"];
  const payload = triggerRequestOf(mail);
  const request = asRecord(payload?.["request"]);
  const repo = request?.["repo"];
  const number = request?.["number"];
  const principalId = payload?.["principalId"];
  if (payload?.["kind"] !== APPROVE_DO_KIND || !isFromTriageSender(mail) || typeof repo !== "string" || typeof number !== "number") return undefined;
  return { repo, number, ...(typeof principalId === "string" && { principalId }) };
}

function terminalStatus(events: readonly WorkflowRunEvent[]): string | undefined {
  const last = events.at(-1);
  const terminal = last && classifyTerminalEvent(last.type);
  return terminal?.terminal ? terminal.status : undefined;
}

function approvedOf(approval: Approval, events: readonly WorkflowRunEvent[]): Approval {
  if (terminalStatus(events) === undefined) return approval;
  const { repo, number } = approval;
  return { ...approval, approved: [...doResults(events, APPROVED_STEPS).values()].map((result) => ({ repo, number, ...result })) };
}

export function approvalIn(events: readonly WorkflowRunEvent[]): Approval | undefined {
  const started = events.find((event) => event.type === "RunStarted");
  const approval = started && approvalOf(started.body);
  return approval && approvedOf(approval, events);
}

/** The evaluate action on either gate branch outputs the verdict; deployments before it rendered it in a `render` step, or older still in `renderJudged`, `renderDet` or `renderAll`. */
const VERDICT_STEPS = new Set(["evaluate", "evaluateRules", "render", "renderJudged", "renderDet", "renderAll"]);
/** The PR workflow's `decide` replaces the verdict's Dos with those it chose. */
const DECIDE_STEPS = new Set(["decide"]);
const EXECUTE_STEPS = new Set(["execute", "executeRules"]);
const APPROVED_STEPS = new Set(["executeApproved"]);

function lastCompleted(events: readonly WorkflowRunEvent[], steps: ReadonlySet<string>): WorkflowRunEvent | undefined {
  return events.findLast((event) => event.type === "StepCompleted" && steps.has(String(event.body["stepId"]).split(/[/.]/).pop()!));
}

/** A step's inline output; an agent step wraps it in `{ reply }`. */
export function inlineOutput(event: WorkflowRunEvent | undefined): Record<string, unknown> | undefined {
  const ref = asRecord(event?.body["output"])?.["ref"];
  if (typeof ref !== "string" || !ref.startsWith(INLINE_PREFIX)) return undefined;
  const output = asRecord(parseJson(ref.slice(INLINE_PREFIX.length)));
  return output && Object.hasOwn(output, "reply") ? asRecord(parseJson(output["reply"])) : output;
}

function doResults(events: readonly WorkflowRunEvent[], steps = EXECUTE_STEPS): Map<string, DoResult> {
  return doResultsOf(inlineOutput(lastCompleted(events, steps)));
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The PR workflow's one verdict once its `decide` step ran: the Dos it made, then evaluate's Dos it did not make that
 * wait for a maintainer: those it left `held`, with why, and those evaluate held itself, with evaluate's reason.
 */
function decidedOf(events: readonly WorkflowRunEvent[], verdict: Record<string, unknown>): Record<string, unknown> {
  const decided = inlineOutput(lastCompleted(events, DECIDE_STEPS));
  const chosen = asRecord(decided?.["verdict"]);
  if (!chosen) return verdict;
  const made = new Set(listOf(chosen["actions"]).map((action) => asRecord(action)?.["effectId"]));
  const held = new Map(listOf(decided?.["held"]).flatMap((entry) => {
    const read = DoResult(entry);
    return read instanceof type.errors ? [] : [[read.effectId, read.error] as const];
  }));
  const left = listOf(verdict["actions"]).flatMap((action) => {
    const own = asRecord(action);
    const effectId = own?.["effectId"];
    if (typeof effectId !== "string" || made.has(effectId)) return [];
    if (held.has(effectId)) return [{ ...own, held: true, reason: held.get(effectId) }];
    return own?.["held"] === true ? [own] : [];
  });
  return { ...chosen, actions: [...listOf(chosen["actions"]), ...left] };
}

/** A batch run outputs `{ items }` in the order its mail named the heads; a single run outputs the verdict itself. */
function verdictsOf(events: readonly WorkflowRunEvent[]): Array<Record<string, unknown> | undefined> {
  const verdict = inlineOutput(lastCompleted(events, VERDICT_STEPS));
  if (!verdict) return [];
  const items = verdict["items"];
  const results = doResults(events);
  return (Array.isArray(items) ? items.map(asRecord) : [decidedOf(events, verdict)]).map((item) => withResults(item, results));
}

export function verdictFor(events: readonly WorkflowRunEvent[], repo: string, number: number): Record<string, unknown> | undefined {
  return verdictsOf(events).find((verdict) => verdict?.["repo"] === repo && verdict["number"] === number);
}
