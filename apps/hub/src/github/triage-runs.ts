// The live pr-triage deployment's runs, read from its committed run event log
// and keyed by the pull request head their trigger named.
import { and, eq, inArray } from "drizzle-orm";
import { type } from "arktype";
import { triggerRequestOf } from "@corbits/triage-contracts";
import { schema, type DB } from "@intx/db";
import { formatRunAddress } from "@intx/types";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunEvent, type WorkflowRunReader } from "@intx/hub-sessions";
import type { LiveDeployment } from "./deployment.js";
import { MODEL_NOT_ASKED, runKey, type ObservedRun } from "./reconcile-plan.js";
import type { RecordedDo, RecordedVerdict } from "./verdict-record-store.js";

const TERMINAL_EVENTS: Record<string, Terminal["status"]> = {
  RunCompleted: "completed",
  RunFailed: "failed",
  RunCancelled: "cancelled",
};
const INLINE_PREFIX = "inline:";
const NO_VERDICT = "run completed without a verdict";

type Trigger = { repo: string; number: number; headSha: string; startedAt: string };
type Unsettled = Pick<ObservedRun, "unsettled" | "unconfirmed">;
type Terminal = Unsettled & { status: Exclude<ObservedRun["status"], "running"> };
type Summary = Omit<RecordedVerdict, "runId" | "repo" | "number" | "headSha" | "startedAt" | "settled">;
type Head = { trigger: Trigger; terminal?: Terminal; summary?: Summary };
/** No heads when the trigger names no pull request head, such as a portal run typed without a sha; a catch-up mail names several. */
type KnownRun = { anchorRunId: string; heads: Head[] };

export type ObservedRuns = {
  /** Runs by repository, then by `runKey`. */
  byRepo: Map<string, Map<string, ObservedRun[]>>;
  /** Runs in the log, one per mail it received, including those that name no pull request head. */
  runCount: number;
  /** One per head a completed run made a verdict for. */
  verdicts: RecordedVerdict[];
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

function headOf(item: unknown, repo: string, startedAt: string): Trigger[] {
  const number = asRecord(item)?.["prNumber"];
  const headSha = asRecord(item)?.["headSha"];
  if (typeof number !== "number" || typeof headSha !== "string" || headSha === "") return [];
  return [{ repo, number, headSha, startedAt }];
}

/** The heads a mail named: one as `prNumber`/`headSha`, or several as `items` of the same. */
function triggersOf(started: Record<string, unknown>): Trigger[] {
  const payload = triggerRequestOf(asRecord(started["trigger"])?.["payload"]);
  const repo = payload?.["repo"];
  const startedAt = started["at"];
  if (payload?.["kind"] !== "pr" || typeof repo !== "string" || typeof startedAt !== "string") return [];
  const items = payload["items"];
  return (Array.isArray(items) ? items : [payload]).flatMap((item) => headOf(item, repo, startedAt));
}

/** The evaluate action on either gate branch outputs the verdict; deployments before it rendered it in a `render` step. */
const VERDICT_STEPS = new Set(["evaluate", "evaluateRules", "render"]);
const MIRROR_STEPS = new Set(["mirror", "mirrorRules"]);

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

function isUnconfirmedMachineCheck(check: unknown): boolean {
  const result = asRecord(check);
  return result?.["kind"] === "machine" && result["result"] === "unconfirmed";
}

/** Every model check of the verdict was skipped, outside a stale-unknown verdict that skips them by design. */
function modelNotAsked(verdict: Record<string, unknown>, checks: unknown[]): boolean {
  const model = checks.map(asRecord).filter((check) => check?.["kind"] === "model");
  return verdict["state"] !== "stale-unknown" && model.length > 0 && model.every((check) => check?.["reason"] === "not asked");
}

/** A batch run outputs `{ items }` in the order its mail named the heads; a single run outputs the verdict itself. */
function verdictsOf(events: readonly WorkflowRunEvent[]): Array<Record<string, unknown> | undefined> {
  const verdict = inlineOutput(lastCompleted(events, VERDICT_STEPS));
  if (!verdict) return [];
  const items = verdict["items"];
  return Array.isArray(items) ? items.map(asRecord) : [verdict];
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
  "checks?": type({ check: "string", result: "string" }).array(),
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

/** What the stats read of a verdict; none for one written before it carried these fields or made for another head. */
function summaryOf(verdict: Record<string, unknown>, at: unknown, trigger: Trigger, mirrored: ReadonlySet<string>): Summary | undefined {
  const fields = SummaryFields(verdict);
  if (fields instanceof type.errors || typeof at !== "string" || verdict["repo"] !== trigger.repo || verdict["number"] !== trigger.number) return undefined;
  return {
    verdictAt: new Date(at),
    state: fields.state,
    actor: fields.actor,
    humanGated: fields.humanGated,
    degraded: fields.degraded ?? null,
    checks: (fields.checks ?? []).map(({ check, result }) => ({ check, result })),
    dos: suggestedDos(fields.actions ?? []),
    commented: (fields.request?.comment ?? "") !== "" && mirrored.has(mirrorCallId(trigger.repo, trigger.number)),
  };
}

/** The verdict a run made for one pull request; a batch run holds one per head. */
export function verdictFor(events: readonly WorkflowRunEvent[], repo: string, number: number): Record<string, unknown> | undefined {
  return verdictsOf(events).find((verdict) => verdict?.["repo"] === repo && verdict["number"] === number);
}

/** Why the verdict does not settle the triggered head: degraded, made on another commit, a machine check GitHub had not computed yet, or the decision model never asked. */
function unsettledBy(verdict: Record<string, unknown>, headSha: string): Unsettled {
  const degraded = verdict["degraded"];
  if (degraded !== undefined && degraded !== null) {
    const reason = verdict["reason"];
    return { unsettled: `degraded: ${typeof reason === "string" && reason !== "" ? reason : String(degraded)}` };
  }
  const made = verdict["headSha"];
  // A verdict from before heads were stamped settles.
  if (typeof made === "string" && made !== headSha) return { unsettled: `verdict made on head ${made}` };
  const checks = Array.isArray(verdict["checks"]) ? verdict["checks"] : [];
  const unconfirmed = checks.filter(isUnconfirmedMachineCheck).map((check) => String(asRecord(check)?.["check"]));
  if (unconfirmed.length > 0) return { unsettled: `unconfirmed checks: ${unconfirmed.join(", ")}`, unconfirmed: true };
  if (modelNotAsked(verdict, checks)) return { unsettled: MODEL_NOT_ASKED };
  return {};
}

function terminalOf(status: Terminal["status"], verdict: Record<string, unknown> | undefined, headSha: string): Terminal {
  if (!verdict) return { status, unsettled: NO_VERDICT };
  return { status, ...unsettledBy(verdict, headSha) };
}

/** The verdict step's output is the verdict: one per head in mail order, or one degraded verdict for every head. Any other count pairs nothing, so no head settles on another's verdict. */
function headsOf(events: readonly WorkflowRunEvent[], triggers: readonly Trigger[]): Head[] {
  const status = TERMINAL_EVENTS[events.at(-1)?.type ?? ""];
  if (status === undefined) return triggers.map((trigger) => ({ trigger }));
  if (status !== "completed") return triggers.map((trigger) => ({ trigger, terminal: { status } }));
  const verdicts = verdictsOf(events);
  const verdictAt = lastCompleted(events, VERDICT_STEPS)?.body["at"];
  const mirrored = mirroredCalls(events);
  return triggers.map(function headVerdict(trigger, i) {
    const verdict = verdicts.length === triggers.length ? verdicts[i] : verdicts.length === 1 ? verdicts[0] : undefined;
    const summary = verdict && summaryOf(verdict, verdictAt, trigger, mirrored);
    return { trigger, terminal: terminalOf(status, verdict, trigger.headSha), ...(summary && { summary }) };
  });
}

export type ObserveRuns = (anchorRunId: string, domain: string) => Promise<ObservedRuns>;

function withVersion(runs: ObservedRuns, workflowVersion: string): ObservedRuns {
  const byRepo: ObservedRuns["byRepo"] = new Map();
  for (const [repo, byHead] of runs.byRepo) {
    byRepo.set(repo, new Map([...byHead].map(([key, list]) => [key, list.map((run) => ({ ...run, workflowVersion }))])));
  }
  return { ...runs, byRepo };
}

/** Each deployment's runs, in the order given, stamped with the workflow version the deployment runs. */
export async function observeDeployments(observe: ObserveRuns, deployments: readonly Pick<LiveDeployment, "runId" | "workflowVersion">[], domain: string): Promise<ObservedRuns[]> {
  const observed: ObservedRuns[] = [];
  for (const { runId, workflowVersion } of deployments) {
    const runs = await observe(runId, domain);
    observed.push(workflowVersion === undefined ? runs : withVersion(runs, workflowVersion));
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
  return { byRepo, runCount, verdicts: observed.flatMap((runs) => runs.verdicts) };
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
      if (known.has(runId) && !ended) {
        open.push(runId);
        continue;
      }
      const events = await deps.runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, runId);
      const started = events.find((e) => e.type === "RunStarted");
      // A run that has not committed RunStarted yet is read again next pass.
      if (!started) continue;
      const heads = headsOf(events, triggersOf(started.body));
      remember(runId, { anchorRunId, heads });
      if (heads.some((head) => head.terminal === undefined)) open.push(runId);
    }
    const settled = await deps.readSettled(anchorRunId, open);
    for (const [runId, status] of settled) {
      const run = known.get(runId);
      if (run) remember(runId, { ...run, heads: run.heads.map((head) => ({ ...head, terminal: { status } })) });
    }

    const byRepo: ObservedRuns["byRepo"] = new Map();
    const verdicts: RecordedVerdict[] = [];
    for (const runId of [...settledIds, ...latest.keys()]) {
      for (const { trigger, terminal, summary } of known.get(runId)?.heads ?? []) {
        const { repo, number, headSha, startedAt } = trigger;
        if (summary) verdicts.push({ runId, repo, number, headSha, startedAt: new Date(startedAt), settled: terminal?.unsettled === undefined, ...summary });
        const byHead = byRepo.get(repo) ?? new Map<string, ObservedRun[]>();
        byRepo.set(repo, byHead);
        const key = runKey(number, headSha);
        const seen: ObservedRun = {
          runId,
          status: terminal?.status ?? "running",
          startedAt,
          ...(terminal?.unsettled !== undefined && { unsettled: terminal.unsettled }),
          ...(terminal?.unconfirmed && { unconfirmed: true }),
        };
        byHead.set(key, [...(byHead.get(key) ?? []), seen]);
      }
    }
    return { byRepo, runCount: settledIds.size + latest.size, verdicts };
  };
}
