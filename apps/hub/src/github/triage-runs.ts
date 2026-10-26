// The live pr-triage deployment's runs, read from its committed run event log
// and keyed by the pull request head their trigger named.
import { and, eq, inArray } from "drizzle-orm";
import { type } from "arktype";
import { APPROVE_DO_KIND, isFromTriageSender, repoSourceOf, triggerRequestOf, type RepoSource } from "@corbits/triage-contracts";
import { asRecord } from "@corbits/common";
import { schema, type DB } from "@intx/db";
import { formatRunAddress } from "@intx/types";
import { classifyTerminalEvent, WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunEvent, type WorkflowRunReader } from "@intx/hub-sessions";
import { heldForCi, unsettledBy } from "@corbits/triage-workflows/logic/settled";
import type { Judged } from "@corbits/triage-workflows/logic/item";
import type { LiveDeployment } from "./deployment.js";
import { runKey, type ObservedRun } from "./reconcile-plan.js";
import type { ApprovedDo, RecordedVerdict } from "./verdict-record-store.js";
import { DoResult, doResultsOf, eventOf, mirrorOutcomesOf, ruledOf, summaryOf, withResults, type Ruled, type Summary, type Trigger } from "./verdict-row.js";

const INLINE_PREFIX = "inline:";
const NO_VERDICT = "run completed without a verdict";

type Unsettled = Pick<ObservedRun, "unsettled" | "unconfirmed" | "heldForCi">;
type Terminal = Unsettled & { status: Exclude<ObservedRun["status"], "running"> };
type Head = { trigger: Trigger; terminal?: Terminal; summary?: Summary; judged?: Judged };
/** No heads when the trigger names no pull request head, such as a portal run typed without a sha; a catch-up mail names several. */
/** An approval run names no head; `approved` is set once it ended, empty when it wrote nothing. `principalId` is who approved. */
export type Approval = { repo: string; number: number; principalId?: string; approved?: ApprovedDo[] };
type KnownRun = {
  anchorRunId: string;
  heads: Head[];
  /** A backlog mail names no heads, so its run is read until it ends, when its verdicts name them. */
  backlog?: { ended: boolean };
  approval?: Approval;
  /** The newest event read; a running run is read again once its log moves past it. */
  seq: number;
};

export type ObservedRuns = {
  byRepo: Map<string, Map<string, ObservedRun[]>>;
  /** Runs in the log, one per mail it received, including those that name no pull request head. */
  runCount: number;
  /** One per head a run made a verdict for, from when its verdict step completed, however the run then ends. */
  verdicts: RecordedVerdict[];
  approved: ApprovedDo[];
};

export function isRunning(runs: ObservedRuns): boolean {
  return [...runs.byRepo.values()].some((byHead) => [...byHead.values()].some((list) => list.some((run) => run.status === "running")));
}

/** Statuses the stock lifecycle settled for these runs, which it can do without a terminal event in the log. */
export type ReadSettled = (anchorRunId: string, runIds: string[]) => Promise<Map<string, Terminal["status"]>>;

export type TriageRunsDeps = {
  runReader: WorkflowRunReader;
  readSettled: ReadSettled;
  /** Runs remembered at most; the oldest is forgotten first and read again while it is still in the log. */
  maxKnownRuns: number;
};

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function headOf(item: unknown, repo: string, source: RepoSource, startedAt: string, event: string | undefined): Trigger[] {
  const number = asRecord(item)?.["prNumber"];
  const headSha = asRecord(item)?.["headSha"];
  if (typeof number !== "number" || typeof headSha !== "string" || headSha === "") return [];
  return [{ repo, source, number, headSha, startedAt, ...(event !== undefined && { event }) }];
}

function isBacklog(started: Record<string, unknown>): boolean {
  return triggerRequestOf(asRecord(started["trigger"])?.["payload"])?.["kind"] === "backlog";
}

/** The heads a mail named: one as `prNumber`/`headSha`, or several as `items` of the same. */
function triggersOf(started: Record<string, unknown>): Trigger[] {
  const payload = triggerRequestOf(asRecord(started["trigger"])?.["payload"]);
  const repo = payload?.["repo"];
  const startedAt = started["at"];
  if (payload?.["kind"] !== "pr" || typeof repo !== "string" || typeof startedAt !== "string") return [];
  const items = payload["items"];
  const source = repoSourceOf(payload["repoSource"]);
  return (Array.isArray(items) ? items : [payload]).flatMap((item) => headOf(item, repo, source, startedAt, eventOf(payload)));
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

function terminalStatus(events: readonly WorkflowRunEvent[]): Terminal["status"] | undefined {
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
const RULES_STEPS = new Set(["rules"]);
const MIRROR_STEPS = new Set(["mirror", "mirrorRules"]);
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

function ruledIn(events: readonly WorkflowRunEvent[]): Map<string, Ruled> {
  return ruledOf(inlineOutput(lastCompleted(events, RULES_STEPS)));
}

function mirrorOutcomes(events: readonly WorkflowRunEvent[]): Map<string, Record<string, unknown>> {
  return mirrorOutcomesOf(inlineOutput(lastCompleted(events, MIRROR_STEPS)));
}

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
  return { status, ...unsettledBy(verdict, headSha), ...(heldForCi(verdict) && { heldForCi: true }) };
}

function headVerdictOf<T>(verdicts: readonly T[], heads: number, index: number): T | undefined {
  if (verdicts.length === heads) return verdicts[index];
  if (verdicts.length === 1) return verdicts[0];
  return undefined;
}

type Paired = { trigger: Trigger; verdict: Record<string, unknown> | undefined };

/** The verdict step's output is the verdict: one per head in mail order, or one degraded verdict for every head. Any other count pairs nothing, so no head settles on another's verdict. */
function mailPairs(started: Record<string, unknown>, verdicts: ReadonlyArray<Record<string, unknown> | undefined>): Paired[] {
  const triggers = triggersOf(started);
  return triggers.map((trigger, i) => ({ trigger, verdict: headVerdictOf(verdicts, triggers.length, i) }));
}

/** A backlog mail names no heads: they are the pull requests its run made a verdict for, each paired with its own. */
function backlogPairs(started: Record<string, unknown>, verdicts: ReadonlyArray<Record<string, unknown> | undefined>): Paired[] {
  const payload = triggerRequestOf(asRecord(started["trigger"])?.["payload"]);
  const repo = payload?.["repo"];
  const startedAt = started["at"];
  if (typeof repo !== "string" || typeof startedAt !== "string") return [];
  const source = repoSourceOf(payload?.["repoSource"]);
  return verdicts.flatMap((verdict) => headOf({ prNumber: verdict?.["number"], headSha: verdict?.["headSha"] }, repo, source, startedAt, undefined).map((trigger) => ({ trigger, verdict })));
}

function headsOf(events: readonly WorkflowRunEvent[], started: Record<string, unknown>): Head[] {
  const status = terminalStatus(events);
  const verdicts = verdictsOf(events);
  const verdictAt = lastCompleted(events, VERDICT_STEPS)?.body["at"];
  const mirrored = mirrorOutcomes(events);
  const ruled = ruledIn(events);
  const pairs = isBacklog(started) ? backlogPairs(started, verdicts) : mailPairs(started, verdicts);
  // The verdict is kept from when its step completed, so a run that fails after it still shows it.
  return pairs.map(function headVerdict({ trigger, verdict }) {
    const summary = verdict && summaryOf(verdict, verdictAt, trigger, mirrored, ruled.get(`${trigger.repo}#${trigger.number}`));
    const kept = { trigger, ...(summary && { summary }) };
    if (status === undefined) return kept;
    if (status !== "completed") return { ...kept, terminal: { status } };
    const judged = verdict && judgedOf(verdict, trigger);
    return { ...kept, terminal: terminalOf(status, verdict, trigger.headSha), ...(judged && { judged }) };
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
  return { byRepo, runCount, verdicts: observed.flatMap((runs) => runs.verdicts), approved: observed.flatMap((runs) => runs.approved) };
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

  function running(run: KnownRun): boolean {
    return run.heads.some((head) => head.terminal === undefined) || (run.approval !== undefined && run.approval.approved === undefined) || run.backlog?.ended === false;
  }

  /** A finished log never changes, so a settled run is never read again. */
  function settledRuns(anchorRunId: string): Set<string> {
    const ids = new Set<string>();
    for (const [runId, run] of known) {
      if (run.anchorRunId === anchorRunId && !running(run)) ids.add(runId);
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
      const ended = event !== null && classifyTerminalEvent(event.type).terminal;
      if (!ended && known.get(runId)?.seq === (event?.seq ?? -1)) {
        open.push(runId);
        continue;
      }
      const events = await deps.runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, runId);
      const started = events.find((e) => e.type === "RunStarted");
      // A run that has not committed RunStarted yet is read again next pass.
      if (!started) continue;
      const heads = headsOf(events, started.body);
      const approval = approvalOf(started.body);
      const backlog = isBacklog(started.body) && { backlog: { ended: terminalStatus(events) !== undefined } };
      const run: KnownRun = { anchorRunId, heads, ...(approval && { approval: approvedOf(approval, events) }), ...backlog, seq: events.at(-1)?.seq ?? -1 };
      remember(runId, run);
      if (running(run)) open.push(runId);
    }
    const settled = await deps.readSettled(anchorRunId, open);
    for (const [runId, status] of settled) {
      const run = known.get(runId);
      if (!run) continue;
      const approval = run.approval && { ...run.approval, approved: run.approval.approved ?? [] };
      remember(runId, { ...run, heads: run.heads.map((head) => ({ ...head, terminal: { status } })), ...(approval && { approval }), ...(run.backlog && { backlog: { ended: true } }) });
    }

    const byRepo: ObservedRuns["byRepo"] = new Map();
    const verdicts: RecordedVerdict[] = [];
    const approved: ApprovedDo[] = [];
    for (const runId of [...settledIds, ...latest.keys()]) {
      approved.push(...(known.get(runId)?.approval?.approved ?? []));
      for (const { trigger, terminal, summary, judged } of known.get(runId)?.heads ?? []) {
        const { repo, number, headSha, startedAt } = trigger;
        if (summary) verdicts.push({ runId, repo, number, headSha, startedAt: new Date(startedAt), ...summary, runStatus: terminal?.status ?? "running" });
        const byHead = byRepo.get(repo) ?? new Map<string, ObservedRun[]>();
        byRepo.set(repo, byHead);
        const key = runKey(number, headSha);
        const seen: ObservedRun = {
          runId,
          source: trigger.source,
          status: terminal?.status ?? "running",
          startedAt,
          ...(terminal?.unsettled !== undefined && { unsettled: terminal.unsettled }),
          ...(terminal?.unconfirmed && { unconfirmed: true }),
          ...(terminal?.heldForCi && { heldForCi: true }),
          ...(trigger.event !== undefined && { trigger: trigger.event }),
          ...(judged && { judged }),
        };
        byHead.set(key, [...(byHead.get(key) ?? []), seen]);
      }
    }
    return { byRepo, runCount: settledIds.size + latest.size, verdicts, approved };
  };
}
