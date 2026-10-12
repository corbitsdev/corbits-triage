// The live pr-triage deployment's runs, read from its committed run event log
// and keyed by the pull request head their trigger named.
import { and, eq, inArray } from "drizzle-orm";
import { type } from "arktype";
import { ACTION_KINDS, triggerRequestOf } from "@corbits/triage-contracts";
import { schema, type DB } from "@intx/db";
import { formatRunAddress } from "@intx/types";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunEvent, type WorkflowRunReader } from "@intx/hub-sessions";
import { NOT_ASKED_REASON } from "../../../../packages/triage-workflows/src/logic/render.js";
import { unsettledBy } from "../../../../packages/triage-workflows/src/logic/settled.js";
import type { Judged } from "../../../../packages/triage-workflows/src/logic/item.js";
import type { LiveDeployment } from "./deployment.js";
import { runKey, type ObservedRun } from "./reconcile-plan.js";
import type { DoClaim, RecordedOutcome } from "./do-run-store.js";
import { VerdictDetail, type RecordedDo, type RecordedVerdict } from "./verdict-record-store.js";

const TERMINAL_EVENTS: Record<string, Terminal["status"]> = {
  RunCompleted: "completed",
  RunFailed: "failed",
  RunCancelled: "cancelled",
};
const INLINE_PREFIX = "inline:";
const NO_VERDICT = "run completed without a verdict";

type Trigger = { repo: string; number: number; headSha: string; startedAt: string; event?: string };
type Unsettled = Pick<ObservedRun, "unsettled" | "unconfirmed">;
type Terminal = Unsettled & { status: Exclude<ObservedRun["status"], "running"> };
type Summary = Omit<RecordedVerdict, "runId" | "repo" | "number" | "headSha" | "startedAt">;
/** A Do the run's execute step wrote, found already written, or failed to write. */
export type ExecutedDo = Omit<DoClaim, "tenantId" | "source" | "principalId"> & { outcome: RecordedOutcome };
type HeadDo = Omit<ExecutedDo, "runId">;
type Head = { trigger: Trigger; terminal?: Terminal; summary?: Summary; executed?: HeadDo[]; judged?: Judged };
/** No heads when the trigger names no pull request head, such as a portal run typed without a sha; a catch-up mail names several. */
type KnownRun = { anchorRunId: string; heads: Head[]; /** The newest event read; a running run is read again once its log moves past it. */ seq: number };

export type ObservedRuns = {
  /** Runs by repository, then by `runKey`. */
  byRepo: Map<string, Map<string, ObservedRun[]>>;
  /** Runs in the log, one per mail it received, including those that name no pull request head. */
  runCount: number;
  /** One per head a run made a verdict for, from when its verdict step completed, however the run then ends. */
  verdicts: RecordedVerdict[];
  /** Dos the ended runs executed, whether or not the run completed. */
  executed: ExecutedDo[];
};

/** Statuses the stock lifecycle settled for these runs, which it can do without a terminal event in the log. */
export type ReadSettled = (anchorRunId: string, runIds: string[]) => Promise<Map<string, Terminal["status"]>>;

export type TriageRunsDeps = {
  runReader: WorkflowRunReader;
  readSettled: ReadSettled;
  /** Runs remembered at most; the oldest is forgotten first and read again while it is still in the log. */
  maxKnownRuns: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function headOf(item: unknown, repo: string, startedAt: string, event: string | undefined): Trigger[] {
  const number = asRecord(item)?.["prNumber"];
  const headSha = asRecord(item)?.["headSha"];
  if (typeof number !== "number" || typeof headSha !== "string" || headSha === "") return [];
  return [{ repo, number, headSha, startedAt, ...(event !== undefined && { event }) }];
}

/** A webhook mail's `event:action`; catch-up and portal mails name none. */
function eventOf(payload: Record<string, unknown>): string | undefined {
  const { event, action } = payload;
  return typeof event === "string" && typeof action === "string" ? `${event}:${action}` : undefined;
}

/** The heads a mail named: one as `prNumber`/`headSha`, or several as `items` of the same. */
function triggersOf(started: Record<string, unknown>): Trigger[] {
  const payload = triggerRequestOf(asRecord(started["trigger"])?.["payload"]);
  const repo = payload?.["repo"];
  const startedAt = started["at"];
  if (payload?.["kind"] !== "pr" || typeof repo !== "string" || typeof startedAt !== "string") return [];
  const items = payload["items"];
  return (Array.isArray(items) ? items : [payload]).flatMap((item) => headOf(item, repo, startedAt, eventOf(payload)));
}

/** The evaluate action on either gate branch outputs the verdict; deployments before it rendered it in a `render` step, or older still in `renderJudged`, `renderDet` or `renderAll`. */
const VERDICT_STEPS = new Set(["evaluate", "evaluateRules", "render", "renderJudged", "renderDet", "renderAll"]);
const RULES_STEPS = new Set(["rules"]);
const MIRROR_STEPS = new Set(["mirror", "mirrorRules"]);
const EXECUTE_STEPS = new Set(["execute", "executeRules"]);

function lastCompleted(events: readonly WorkflowRunEvent[], steps: ReadonlySet<string>): WorkflowRunEvent | undefined {
  return events.findLast((event) => event.type === "StepCompleted" && steps.has(String(event.body["stepId"]).split(/[/.]/).pop()!));
}

/** A step's inline output; an agent step wraps it in `{ reply }`. */
function inlineOutput(event: WorkflowRunEvent | undefined): Record<string, unknown> | undefined {
  const ref = asRecord(event?.body["output"])?.["ref"];
  if (typeof ref !== "string" || !ref.startsWith(INLINE_PREFIX)) return undefined;
  const output = asRecord(parseJson(ref.slice(INLINE_PREFIX.length)));
  return output && Object.hasOwn(output, "reply") ? asRecord(parseJson(output["reply"])) : output;
}

const DoResult = type({ effectId: "string", status: "string", "error?": "string" });

/** The execute step's outcome of each Do it was given, by effect id. */
function doResults(events: readonly WorkflowRunEvent[]): Map<string, typeof DoResult.infer> {
  const dos = inlineOutput(lastCompleted(events, EXECUTE_STEPS))?.["dos"];
  return new Map((Array.isArray(dos) ? dos : []).flatMap(function parsed(result): Array<[string, typeof DoResult.infer]> {
    const read = DoResult(result);
    return read instanceof type.errors ? [] : [[read.effectId, read]];
  }));
}

/** The verdict with each executed Do carrying its `status`, and `error` when it failed or could not run. */
function withResults(verdict: Record<string, unknown> | undefined, results: ReadonlyMap<string, typeof DoResult.infer>): Record<string, unknown> | undefined {
  const actions = verdict?.["actions"];
  if (!verdict || !Array.isArray(actions) || results.size === 0) return verdict;
  function withResult(action: unknown): unknown {
    const result = results.get(String(asRecord(action)?.["effectId"]));
    return result ? { ...asRecord(action), status: result.status, ...(result.error !== undefined && { error: result.error }) } : action;
  }
  return { ...verdict, actions: actions.map(withResult) };
}

/** A batch run outputs `{ items }` in the order its mail named the heads; a single run outputs the verdict itself. */
function verdictsOf(events: readonly WorkflowRunEvent[]): Array<Record<string, unknown> | undefined> {
  const verdict = inlineOutput(lastCompleted(events, VERDICT_STEPS));
  if (!verdict) return [];
  const items = verdict["items"];
  const results = doResults(events);
  return (Array.isArray(items) ? items.map(asRecord) : [verdict]).map((item) => withResults(item, results));
}

type Ruled = { facts: Record<string, unknown>; evidence: string[] };

/** The reasons the rules step's findings give, which the portal shows when the verdict names none. */
function evidenceOf(det: unknown): string[] {
  const findings = asRecord(det)?.["findings"];
  const reasons = [...(Array.isArray(findings) ? findings.map((finding) => asRecord(finding)?.["reason"]) : []), asRecord(det)?.["reason"]];
  return [...new Set(reasons.filter((reason): reason is string => typeof reason === "string" && reason !== ""))];
}

/** The facts the rules step read for each pull request, and its findings' reasons, by `repo#number`. */
function ruledOf(events: readonly WorkflowRunEvent[]): Map<string, Ruled> {
  const items = inlineOutput(lastCompleted(events, RULES_STEPS))?.["items"];
  return new Map((Array.isArray(items) ? items : []).flatMap(function pull(item): Array<[string, Ruled]> {
    const facts = asRecord(asRecord(item)?.["facts"]);
    return facts ? [[`${String(facts["repo"])}#${String(facts["number"])}`, { facts, evidence: evidenceOf(asRecord(item)?.["det"]) }]] : [];
  }));
}

/** Gates decide actions, not the verdict; a model check the verdict never asked about says nothing about the pull request. */
function recorded(c: { kind?: string; reason?: string; gate?: boolean }): boolean {
  return c.gate !== true && !(c.kind === "model" && c.reason === NOT_ASKED_REASON);
}

/** Mirror calls that succeeded: a batch run outputs `{ results }`, a single run the one outcome. */
function mirroredCalls(events: readonly WorkflowRunEvent[]): Set<string> {
  const output = inlineOutput(lastCompleted(events, MIRROR_STEPS));
  const outcomes = Array.isArray(output?.["results"]) ? output["results"] : [output];
  return new Set(outcomes.map(asRecord).flatMap((outcome) => outcome?.["ok"] === true && typeof outcome["call"] === "string" ? [outcome["call"]] : []));
}

/** The mirror director's call id for one pull request. */
function mirrorCallId(repo: string, number: number): string {
  return `mirror:${repo.replace("/", "--")}:${number}`;
}

const SummaryFields = type({
  state: "string",
  actor: "string",
  humanGated: "boolean",
  "degraded?": "string | null",
  "checks?": type({ check: "string", result: "string", "kind?": "string", "reason?": "string", "gate?": "boolean" }).array(),
  "actions?": "unknown[]",
  "request?": { comment: "string" },
});

function suggestedDos(actions: readonly unknown[]): RecordedDo[] {
  return actions.map(asRecord).flatMap(function suggested(action) {
    const actionId = action?.["id"];
    const effectId = action?.["effectId"];
    return typeof actionId === "string" && typeof effectId === "string" && action?.["skipped"] !== true ? [{ actionId, effectId }] : [];
  });
}

/** The verdict as the portal shows it; none when it does not read as one. */
function detailOf(verdict: Record<string, unknown>, ruled: Ruled | undefined): VerdictDetail | undefined {
  const reason = verdict["reason"];
  const evidence = typeof reason === "string" && reason !== "" ? [reason] : (ruled?.evidence ?? []);
  const detail = VerdictDetail({ ...verdict, evidence, ...(ruled && { facts: ruled.facts }) });
  return detail instanceof type.errors ? undefined : detail;
}

/** What the stats and the portal read of a verdict; none for one written before it carried these fields or made for another head. */
function summaryOf(verdict: Record<string, unknown>, at: unknown, trigger: Trigger, mirrored: ReadonlySet<string>, ruled: Ruled | undefined): Summary | undefined {
  const fields = SummaryFields(verdict);
  if (fields instanceof type.errors || typeof at !== "string" || verdict["repo"] !== trigger.repo || verdict["number"] !== trigger.number) return undefined;
  const detail = detailOf(verdict, ruled);
  return {
    verdictAt: new Date(at),
    settled: unsettledBy(verdict, trigger.headSha).unsettled === undefined,
    state: fields.state,
    actor: fields.actor,
    humanGated: fields.humanGated,
    degraded: fields.degraded ?? null,
    checks: (fields.checks ?? []).filter(recorded).map(({ check, result }) => ({ check, result })),
    dos: suggestedDos(fields.actions ?? []),
    commented: (fields.request?.comment ?? "") !== "" && mirrored.has(mirrorCallId(trigger.repo, trigger.number)),
    ...(detail && { detail }),
    ...(trigger.event !== undefined && { trigger: trigger.event }),
  };
}

const ExecutedBase = type({
  id: "string",
  branch: "'yes' | 'no' | 'unsure' | 'always'",
  index: "number.integer >= 0",
  kind: type.enumerated(...ACTION_KINDS),
  effectId: "string",
});
const ExecutedStep = ExecutedBase.and({ status: "'done' | 'satisfied'" }).or(ExecutedBase.and({ status: "'failed'", error: "string" }));

/** The verdict's Dos the run executed, for the head its trigger named. */
function executedOf(verdict: Record<string, unknown>, trigger: Trigger): HeadDo[] {
  const { headSha, actions } = verdict;
  if (verdict["repo"] !== trigger.repo || verdict["number"] !== trigger.number || typeof headSha !== "string" || !Array.isArray(actions)) return [];
  return actions.flatMap(function executed(action): HeadDo[] {
    const step = ExecutedStep(action);
    if (step instanceof type.errors) return [];
    const { id: actionId, branch, index, kind, effectId } = step;
    const outcome = step.status === "failed" ? { status: step.status, error: step.error } : { status: step.status, result: null };
    return [{ effectId, repo: trigger.repo, number: trigger.number, headSha, actionId, branch, index, kind, outcome }];
  });
}

/** The verdict a run made for one pull request; a batch run holds one per head. */
export function verdictFor(events: readonly WorkflowRunEvent[], repo: string, number: number): Record<string, unknown> | undefined {
  return verdictsOf(events).find((verdict) => verdict?.["repo"] === repo && verdict["number"] === number);
}

/** The judge answers a verdict made on the trigger's head says a later run of it can reuse. */
function judgedOf(verdict: Record<string, unknown>, trigger: Trigger): Judged | undefined {
  const judged = asRecord(verdict["judged"]);
  if (!judged || verdict["headSha"] !== trigger.headSha) return undefined;
  const answers = Object.entries(judged).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return answers.length > 0 ? Object.fromEntries(answers) : undefined;
}

function terminalOf(status: Terminal["status"], verdict: Record<string, unknown> | undefined, headSha: string): Terminal {
  if (!verdict) return { status, unsettled: NO_VERDICT };
  return { status, ...unsettledBy(verdict, headSha) };
}

/** The verdict step's output is the verdict: one per head in mail order, or one degraded verdict for every head. Any other count pairs nothing, so no head settles on another's verdict. */
function headsOf(events: readonly WorkflowRunEvent[], triggers: readonly Trigger[]): Head[] {
  const status = TERMINAL_EVENTS[events.at(-1)?.type ?? ""];
  const verdicts = verdictsOf(events);
  const verdictAt = lastCompleted(events, VERDICT_STEPS)?.body["at"];
  const mirrored = mirroredCalls(events);
  const ruled = ruledOf(events);
  // The verdict is kept from when its step completed, so a run that fails after it still shows it; a run that failed after
  // its execute step still wrote those Dos, so they are recorded whatever the run's end.
  return triggers.map(function headVerdict(trigger, i) {
    const verdict = verdicts.length === triggers.length ? verdicts[i] : verdicts.length === 1 ? verdicts[0] : undefined;
    const summary = verdict && summaryOf(verdict, verdictAt, trigger, mirrored, ruled.get(`${trigger.repo}#${trigger.number}`));
    const kept = { trigger, ...(summary && { summary }) };
    if (status === undefined) return kept;
    const executed = verdict ? executedOf(verdict, trigger) : [];
    if (status !== "completed") return { ...kept, terminal: { status }, executed };
    const judged = verdict && judgedOf(verdict, trigger);
    return { ...kept, terminal: terminalOf(status, verdict, trigger.headSha), executed, ...(judged && { judged }) };
  });
}

/** The verdicts a run's log holds, one per head its trigger named. */
export function recordedVerdicts(runId: string, events: readonly WorkflowRunEvent[]): RecordedVerdict[] {
  const started = events.find((event) => event.type === "RunStarted");
  if (!started) return [];
  return headsOf(events, triggersOf(started.body)).flatMap(function recordedHead({ trigger, terminal, summary }): RecordedVerdict[] {
    if (!summary) return [];
    const { repo, number, headSha, startedAt } = trigger;
    return [{ runId, repo, number, headSha, startedAt: new Date(startedAt), ...summary, runStatus: terminal?.status ?? "running" }];
  });
}

export type ObserveRuns = (anchorRunId: string, domain: string) => Promise<ObservedRuns>;

type Stamp = Pick<ObservedRun, "workflowVersion" | "offeringId">;

function stamped(runs: ObservedRuns, stamp: Stamp): ObservedRuns {
  const byRepo: ObservedRuns["byRepo"] = new Map();
  for (const [repo, byHead] of runs.byRepo) {
    byRepo.set(repo, new Map([...byHead].map(([key, list]) => [key, list.map((run) => ({ ...run, ...stamp }))])));
  }
  return { ...runs, byRepo };
}

/** Each deployment's runs, in the order given, stamped with the workflow version the deployment runs and the decision-model offering it resolved. */
export async function observeDeployments(observe: ObserveRuns, deployments: readonly Pick<LiveDeployment, "runId" | "workflowVersion" | "offeringId">[], domain: string): Promise<ObservedRuns[]> {
  const observed: ObservedRuns[] = [];
  for (const { runId, workflowVersion, offeringId } of deployments) {
    const runs = await observe(runId, domain);
    const stamp = { ...(workflowVersion !== undefined && { workflowVersion }), ...(offeringId !== undefined && { offeringId }) };
    observed.push(Object.keys(stamp).length === 0 ? runs : stamped(runs, stamp));
  }
  return observed;
}

/** Runs of several deployments of the same workflow, as if from one log. */
export function mergeObservedRuns(observed: readonly ObservedRuns[]): ObservedRuns {
  const byRepo: ObservedRuns["byRepo"] = new Map();
  for (const runs of observed) {
    for (const [repo, byHead] of runs.byRepo) {
      const merged = byRepo.get(repo) ?? new Map<string, ObservedRun[]>();
      byRepo.set(repo, merged);
      for (const [key, list] of byHead) merged.set(key, [...(merged.get(key) ?? []), ...list]);
    }
  }
  const runCount = observed.reduce((sum, runs) => sum + runs.runCount, 0);
  return { byRepo, runCount, verdicts: observed.flatMap((runs) => runs.verdicts), executed: observed.flatMap((runs) => runs.executed) };
}

export function createSettledStatusReader(db: DB["db"]): ReadSettled {
  return async function readSettled(anchorRunId, runIds) {
    if (runIds.length === 0) return new Map();
    const { workflowRun } = schema;
    const rows = await db
      .select({ id: workflowRun.id, status: workflowRun.status })
      .from(workflowRun)
      .where(and(eq(workflowRun.anchorRunId, anchorRunId), inArray(workflowRun.id, runIds), inArray(workflowRun.status, ["failed", "cancelled"])));
    return new Map(rows.map((row) => [row.id, row.status as Terminal["status"]]));
  };
}

export function createTriageRuns(deps: TriageRunsDeps) {
  // Insertion-ordered, so the first key is the oldest.
  const known = new Map<string, KnownRun>();

  function remember(runId: string, run: KnownRun): void {
    known.delete(runId);
    known.set(runId, run);
    if (known.size > deps.maxKnownRuns) known.delete(known.keys().next().value!);
  }

  /** A finished log never changes, so a settled run is never read again. */
  function settledRuns(anchorRunId: string): Set<string> {
    const ids = new Set<string>();
    for (const [runId, run] of known) {
      if (run.anchorRunId === anchorRunId && run.heads.every((head) => head.terminal !== undefined)) ids.add(runId);
    }
    return ids;
  }

  return async function observeRuns(anchorRunId: string, domain: string): Promise<ObservedRuns> {
    const repoId = workflowRunRepoIdForAddress(formatRunAddress(anchorRunId, domain));
    const settledIds = settledRuns(anchorRunId);
    const { events: latest } = await deps.runReader.readLatestRunEvents(
      repoId,
      WORKFLOW_RUN_REF,
      (runId) => runId !== anchorRunId && !settledIds.has(runId),
    );
    const open: string[] = [];
    for (const [runId, event] of latest) {
      const ended = event !== null && TERMINAL_EVENTS[event.type] !== undefined;
      if (!ended && known.get(runId)?.seq === (event?.seq ?? -1)) {
        open.push(runId);
        continue;
      }
      const events = await deps.runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, runId);
      const started = events.find((e) => e.type === "RunStarted");
      // A run that has not committed RunStarted yet is read again next pass.
      if (!started) continue;
      const heads = headsOf(events, triggersOf(started.body));
      remember(runId, { anchorRunId, heads, seq: events.at(-1)?.seq ?? -1 });
      if (heads.some((head) => head.terminal === undefined)) open.push(runId);
    }
    const settled = await deps.readSettled(anchorRunId, open);
    for (const [runId, status] of settled) {
      const run = known.get(runId);
      if (run) remember(runId, { ...run, heads: run.heads.map((head) => ({ ...head, terminal: { status } })) });
    }

    const byRepo: ObservedRuns["byRepo"] = new Map();
    const verdicts: RecordedVerdict[] = [];
    const executed: ExecutedDo[] = [];
    for (const runId of [...settledIds, ...latest.keys()]) {
      for (const { trigger, terminal, summary, executed: dos = [], judged } of known.get(runId)?.heads ?? []) {
        const { repo, number, headSha, startedAt } = trigger;
        if (summary) verdicts.push({ runId, repo, number, headSha, startedAt: new Date(startedAt), ...summary, runStatus: terminal?.status ?? "running" });
        executed.push(...dos.map((done) => ({ ...done, runId })));
        const byHead = byRepo.get(repo) ?? new Map<string, ObservedRun[]>();
        byRepo.set(repo, byHead);
        const key = runKey(number, headSha);
        const seen: ObservedRun = {
          runId,
          status: terminal?.status ?? "running",
          startedAt,
          ...(terminal?.unsettled !== undefined && { unsettled: terminal.unsettled }),
          ...(terminal?.unconfirmed && { unconfirmed: true }),
          ...(trigger.event !== undefined && { trigger: trigger.event }),
          ...(judged && { judged }),
        };
        byHead.set(key, [...(byHead.get(key) ?? []), seen]);
      }
    }
    return { byRepo, runCount: settledIds.size + latest.size, verdicts, executed };
  };
}
