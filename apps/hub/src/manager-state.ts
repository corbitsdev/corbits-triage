// A pull request's manager claim and the events waiting for it, one `manager_state` row each. A manager's take claims the
// pull request when no live run holds it, and done checks for pending events under the claim's lock, so an event is
// either taken by the live manager or by the next one. Only the run the claim names takes events or finishes a pass.
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import { jsonb, primaryKey, text } from "drizzle-orm/pg-core";
import { type } from "arktype";
import { canExecuteWorkflowRun, schema, type DB } from "@intx/db";
import { asRecord } from "@corbits/common";
import { APPROVE_DO_KIND, AWAITED_STAGES, REPO_SOURCES, TRIAGE_JUDGES, TRIAGE_LISTENERS, TRIAGE_MANAGERS, type AwaitedStage, type RepoSource } from "@corbits/triage-contracts";
import type { Tx } from "./github/admin-github-grant.js";
import { resolveLiveDeployments, workflowName, type LiveDeployment } from "./github/deployment.js";
import { triageSchema } from "./triage-db.js";
import { START_DEADLINE_MS } from "./workflow-release/rollout.js";

const managerState = triageSchema.table("manager_state", {
  tenantId: text("tenant_id").notNull(),
  key: text("key").notNull(),
  kind: text("kind").$type<"claim" | "event">().notNull(),
  state: jsonb("state").notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.key] })]);

export const PassState = type({ id: "string > 0", head: "string > 0", events: "string[]", takenAt: "string.date.iso", takes: "number.integer >= 1" });
export const ReviewerState = type({ kind: "string > 0", head: "string > 0", runId: "string > 0", deployedBy: "string > 0", deadline: "string.date.iso", "result?": "string | number | boolean | object" });
const ClaimState = type({
  status: "'live' | 'ended'",
  claimId: "string > 0",
  claimedAt: "string.date.iso",
  "runId?": "string > 0",
  "pass?": PassState,
  reviewers: ReviewerState.array(),
  history: PassState.and({ runId: "string > 0", doneAt: "string.date.iso", "waiting?": "true", "request?": "Record<string, unknown>" }).array(),
  starts: "number.integer >= 0",
  "overdueWokenAt?": "string.date.iso",
});
const EventPayload = type("Record<string, unknown>").narrow(function plainObject(value) {
  return !Array.isArray(value);
});
export const EventState = type({
  type: "'webhook' | 'reviewer-result'",
  head: "string > 0",
  payload: EventPayload,
  receivedAt: "string.date.iso",
  "consumedBy?": "string > 0",
  "consumedAt?": "string.date.iso",
});

type Pass = typeof PassState.infer;
type Reviewer = typeof ReviewerState.infer;
type Claim = typeof ClaimState.infer;
type ManagerEvent = typeof EventState.infer;
const NewEvent = EventState.omit("receivedAt", "consumedBy", "consumedAt");
export type PullRequestRef = { source: RepoSource; repo: string; number: number };
type TakenEvent = { key: string; event: ManagerEvent };

type Latest = { request?: Record<string, unknown>; reviewers: Reviewer[]; waitingSince?: string; headSince?: string; claimedAt: string };
type TakeResult = { outcome: "refused" } | ({ outcome: "idle" } & Latest) | ({ outcome: "pass"; pass: Pass; events: TakenEvent[]; resumed: boolean } & Latest);
type ClosedPass = Claim["history"][number];
/** What a pass reports as done closes it: the head it worked on, whether its verdict waits for the host's checks, or the mirror request of the verdict it posted. */
export type PassReport = { head: string; waiting?: true; request?: Record<string, unknown> };
/** A reporting pass's head, when this run's first pass on it was taken, and the newest pull request mail for it. */
export type Closing = { head: string; startedAt: string; mail?: Record<string, unknown> };
/** Records what the closed pass reported in done's transaction, so the claim never moves on without it. */
export type RecordDone = (tx: Tx, closing: Closing | undefined) => Promise<void>;
type DoneResult = { outcome: "refused" } | { outcome: "ended" } | { outcome: "more"; wait: boolean };
/**
 * `wait` when the pass's head still awaits CI or a reviewer, so the manager polls for it before its claim ends. `report`
 * and `record` record what the pass did; `log` names each reviewer it gave up on.
 */
export type DoneOptions = { wait?: boolean; report?: PassReport; record?: RecordDone; log?: (entry: Record<string, unknown>) => void };

function pullKey({ source, repo, number }: PullRequestRef): string {
  return `${source}:${repo}#${number}`;
}

function claimKey(pr: PullRequestRef): string {
  return `mgr:${pullKey(pr)}`;
}

function eventKey(pr: PullRequestRef, deliveryId: string): string {
  return `evt:${pullKey(pr)}:${deliveryId}`;
}

/** The value as the jsonb column will hold it, so what is validated is what is stored. */
function asStored(value: object): unknown {
  return JSON.parse(JSON.stringify(value));
}

function claimOf(key: string, state: unknown): Claim {
  const claim = ClaimState(state);
  if (claim instanceof type.errors) throw new Error(`manager_state ${key} is not a claim: ${claim.summary}`);
  return claim;
}

function eventOf(key: string, state: unknown): ManagerEvent {
  const event = EventState(state);
  if (event instanceof type.errors) throw new Error(`manager_state ${key} is not an event: ${event.summary}`);
  return event;
}

/** The pull request's event keys' prefix as a LIKE pattern. */
function eventPrefix(pr: PullRequestRef): string {
  return eventKey(pr, "").replace(/[\\%_]/g, "\\$&");
}

/** The kind is a literal so a generic plan still matches the partial index. */
function pending(tenantId: string, pr: PullRequestRef) {
  const prefix = eventPrefix(pr);
  return and(eq(managerState.tenantId, tenantId), sql`${managerState.kind} = 'event'`, sql`${managerState.state}->>'consumedBy' IS NULL`, like(managerState.key, `${prefix}%`));
}

async function lockClaim(tx: Tx, tenantId: string, pr: PullRequestRef): Promise<Claim | undefined> {
  const key = claimKey(pr);
  const [row] = await tx.select({ state: managerState.state }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), eq(managerState.key, key), eq(managerState.kind, "claim")))
    .for("update");
  return row && claimOf(key, row.state);
}

async function writeClaim(tx: Tx, tenantId: string, pr: PullRequestRef, claim: Claim): Promise<void> {
  const key = claimKey(pr);
  await tx.update(managerState).set({ state: claimOf(key, asStored(claim)) }).where(and(eq(managerState.tenantId, tenantId), eq(managerState.key, key)));
}

function fencedTo(claim: Claim | undefined, runId: string): claim is Claim {
  return claim?.status === "live" && claim.runId === runId;
}

async function eventsByKey(tx: Tx, tenantId: string, keys: readonly string[]): Promise<TakenEvent[]> {
  const rows = await tx.select({ key: managerState.key, state: managerState.state }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), eq(managerState.kind, "event"), inArray(managerState.key, [...keys])));
  return eventsOf(rows);
}

function eventsOf(rows: readonly { key: string; state: unknown }[]): TakenEvent[] {
  return rows
    .map((row) => ({ key: row.key, event: eventOf(row.key, row.state) }))
    .sort((a, b) => a.event.receivedAt.localeCompare(b.event.receivedAt) || a.key.localeCompare(b.key));
}

/** The newest webhook's head; with none taken, the head the last pass ran on, which a reviewer result must name. */
/**
 * The head a pass over `taken` works on, or undefined when there is none or none of them is usable yet: the newest mail's, else the head
 * the last pass ran on, else an approval's. A held Do's approval names the head it was held on, which a newer push may
 * have moved past, so it names the pass's head only when nothing else does; its execute checks the current head. A
 * reviewer result alone, before any pass, has no head to be judged against and stays pending. Take and done share it,
 * so done never waits on events take would leave pending.
 */
function passHeadOf(taken: readonly TakenEvent[], history: Claim["history"]): string | undefined {
  if (taken.length === 0) return undefined;
  const mails = taken.filter((row) => row.event.type === "webhook");
  return mails.findLast((row) => row.event.payload["kind"] !== APPROVE_DO_KIND)?.event.head ?? history.at(-1)?.head ?? mails.at(-1)?.event.head;
}

/** The event's row key and state under its delivery id. */
function newEvent(pr: PullRequestRef, deliveryId: string, event: Pick<ManagerEvent, "type" | "head" | "payload">): { key: string; state: SQL } {
  if (deliveryId.length === 0) throw new Error(`an event for ${claimKey(pr)} has no delivery id`);
  const key = eventKey(pr, deliveryId);
  const fields = NewEvent(asStored({ type: event.type, head: event.head, payload: event.payload }));
  if (fields instanceof type.errors) throw new Error(`manager_state ${key} is not an event: ${fields.summary}`);
  // Stamped by the database to the microsecond as it inserts the row, so events sort in the order they were recorded.
  return { key, state: sql`${JSON.stringify(fields)}::jsonb || jsonb_build_object('receivedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))` };
}

/** Records the event under its delivery id; false when it was recorded before, as on a redelivery. */
export async function recordEvent(db: DB["db"], tenantId: string, pr: PullRequestRef, deliveryId: string, event: Pick<ManagerEvent, "type" | "head" | "payload">): Promise<boolean> {
  const { key, state } = newEvent(pr, deliveryId, event);
  const inserted = await db.insert(managerState).values({ tenantId, key, kind: "event", state }).onConflictDoNothing().returning({ key: managerState.key });
  return inserted.length === 1;
}

const ResultRecorded = type([{ recorded: "0 | 1", current: "string | null" }]);

/**
 * Records a reviewer's result on `head` under its run's id, in one statement only while `head` is the newest a pull
 * request mail named, or none named one yet, so a push recorded meanwhile cannot slip between the check and the record.
 * `recorded` is false as well when the run reported before; `current` is the newest head the statement saw.
 */
export async function recordResult(db: DB["db"], tenantId: string, pr: PullRequestRef, runId: string, head: string, payload: Record<string, unknown>): Promise<{ recorded: boolean; current: string | undefined }> {
  const { key, state } = newEvent(pr, runId, { type: "reviewer-result", head, payload });
  const [row] = ResultRecorded.assert(await db.execute(sql`
    WITH newest AS (SELECT ${managerState.state}->>'head' AS head FROM ${managerState} WHERE ${mails(tenantId, pr)} ORDER BY ${newestFirst} LIMIT 1),
    inserted AS (
      INSERT INTO ${managerState} (tenant_id, key, kind, state)
      SELECT ${tenantId}, ${key}, 'event', ${state} WHERE NOT EXISTS (SELECT 1 FROM newest WHERE head <> ${head})
      ON CONFLICT DO NOTHING RETURNING 1
    )
    SELECT (SELECT count(*) FROM inserted)::int AS recorded, (SELECT head FROM newest) AS current`));
  return { recorded: row.recorded === 1, current: row.current ?? undefined };
}

/**
 * How long a just-deployed manager may have no sidecar and still hold the pull request, and a just-deployed listener
 * still count as live. The listener waits this long for a manager to start.
 */
const MANAGER_START_GRACE_MS = 2 * 60_000;

/**
 * How long a manager or judge may sit on its sidecar without its first mail starting it. Both are deployed with that
 * mail, so one still waiting is stuck. A listener is exempt: it stays deployed until its first pull request arrives.
 */
const NEVER_RAN_MS = 5 * 60_000;

/** The workflows deployed with the mail that starts them. */
const MAILED_WORKFLOWS = [...Object.values(TRIAGE_MANAGERS), ...Object.values(TRIAGE_JUDGES)];

type Placement = { readonly allocationId: string; readonly generation: number };

/** When this hub saw each allocation's current generation reach its sidecar; one placed before the hub started dates from its start. */
const placements = new Map<string, { generation: number; at: Date }>();
const hubStartedAt = new Date();

/** Records when an allocation's generation reached its sidecar, so a run that waited for a slot is timed from there. */
export function notePlaced({ allocationId, generation }: Placement, at = new Date()): void {
  if (placements.get(allocationId)?.generation === generation) return;
  // An entry older than the window no longer keeps any run up, so it can go.
  for (const [id, placed] of placements) if (at.getTime() - placed.at.getTime() > NEVER_RAN_MS) placements.delete(id);
  placements.set(allocationId, { generation, at });
}

type ManagerRun = {
  status: string;
  createdAt: Date;
  expiresAt: Date | null;
  cancellationRequestedAt: Date | null;
  allocationId: string | null;
  generation: number | null;
  allocationStatus: string | null;
  sidecarId: string | null;
};

/** How long the run has sat on its sidecar: from its deploy, or its placement there when that came later. */
function onSidecarMs(run: Pick<ManagerRun, "createdAt" | "allocationId" | "generation">, now: Date): number {
  const placed = run.allocationId === null ? undefined : placements.get(run.allocationId);
  const placedAt = placed !== undefined && placed.generation === run.generation ? placed.at : hubStartedAt;
  return now.getTime() - Math.max(run.createdAt.getTime(), placedAt.getTime());
}

async function managerRun(tx: Tx | DB["db"], runId: string): Promise<ManagerRun | undefined> {
  const [run] = await tx
    .select({
      status: schema.workflowRun.status,
      createdAt: schema.workflowRun.createdAt,
      expiresAt: schema.workflowRun.expiresAt,
      cancellationRequestedAt: schema.workflowRun.cancellationRequestedAt,
      allocationId: schema.sidecarAllocation.id,
      generation: schema.sidecarAllocation.generation,
      allocationStatus: schema.sidecarAllocation.status,
      sidecarId: schema.sidecarAllocation.sidecarId,
    })
    .from(schema.workflowRun)
    .leftJoin(schema.sidecarAllocation, eq(schema.sidecarAllocation.anchorRunId, schema.workflowRun.id))
    .where(eq(schema.workflowRun.id, runId));
  return run;
}

/** A just-deployed listener counts as live longer than a roll waits for it, so one a roll still waits on is never released. */
const LISTENER_START_GRACE_MS = START_DEADLINE_MS + 60_000;

/** A run that is running, or whose sidecar is up. */
function runIsRunning(run: ManagerRun | undefined): boolean {
  if (!run || !schema.isLiveWorkflowRunStatus(run.status)) return false;
  return run.status === "running" || (run.allocationStatus === "allocated" && run.sidecarId !== null);
}

type UpRule = { readonly graceMs?: number; readonly startedByMail: boolean };

/**
 * A running run; one on its sidecar, unless it is started by its mail and sat there past `NEVER_RAN_MS`; or one
 * deployed inside the startup window.
 */
function runIsUp(run: ManagerRun | undefined, now: Date, { graceMs = MANAGER_START_GRACE_MS, startedByMail }: UpRule): boolean {
  if (!run || !schema.isLiveWorkflowRunStatus(run.status)) return false;
  if (run.status === "running") return true;
  if (run.allocationStatus === "allocated" && run.sidecarId !== null) return !startedByMail || onSidecarMs(run, now) < NEVER_RAN_MS;
  return now.getTime() - run.createdAt.getTime() < graceMs;
}

async function runGone(tx: Tx | DB["db"], runId: string, now: Date): Promise<boolean> {
  return !runIsUp(await managerRun(tx, runId), now, { startedByMail: true });
}

/** Whether a deployment is up as the hub counts a listener: running, on its sidecar, or just deployed. */
export async function deploymentUp(db: DB["db"], runId: string): Promise<boolean> {
  return runIsUp(await managerRun(db, runId), new Date(), { startedByMail: false });
}

/**
 * Asks the sweep to stop a deploy that still counts as live but never became a process, or never ran, so a manager
 * cannot start after its claim has moved on, and a listener is deployed again by the hub's next roll of the workspace.
 */
async function releaseStuck(tx: Tx | DB["db"], runId: string, now: Date, reason: string): Promise<void> {
  await tx
    .update(schema.workflowRun)
    .set({ cancellationRequestedAt: now, cancellationDeadline: now, cancellationReason: reason })
    .where(and(eq(schema.workflowRun.id, runId), inArray(schema.workflowRun.status, [...schema.liveWorkflowRunStatuses]), isNull(schema.workflowRun.cancellationRequestedAt)));
}

/** Ends every manager and judge that sat on its sidecar past `NEVER_RAN_MS` without its mail starting it. */
export async function endNeverRan(
  db: DB["db"],
  now: Date,
  cancel: (tenantId: string, runId: string, reason: string) => Promise<unknown>,
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const { workflowRun, workflowDefinition, workflowRunLaunchSpec, sidecarAllocation } = schema;
  const candidates = await db
    .select({ tenantId: workflowRun.tenantId, runId: workflowRun.id, workflow: workflowName, createdAt: workflowRun.createdAt, allocationId: sidecarAllocation.id, generation: sidecarAllocation.generation })
    .from(workflowRun)
    .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
    .leftJoin(workflowRunLaunchSpec, eq(workflowRunLaunchSpec.anchorRunId, workflowRun.id))
    .innerJoin(sidecarAllocation, eq(sidecarAllocation.anchorRunId, workflowRun.id))
    .where(and(
      eq(workflowRun.id, workflowRun.anchorRunId),
      eq(workflowRun.status, "deployed"),
      isNull(workflowRun.cancellationRequestedAt),
      lt(workflowRun.createdAt, new Date(now.getTime() - NEVER_RAN_MS)),
      eq(sidecarAllocation.status, "allocated"),
      isNotNull(sidecarAllocation.sidecarId),
      inArray(workflowName, MAILED_WORKFLOWS),
    ));
  for (const run of candidates) {
    if (onSidecarMs(run, now) < NEVER_RAN_MS) continue;
    await cancel(run.tenantId, run.runId, `${run.workflow} deployed but never ran`);
    log({ level: "warn", msg: "triage_deployment_never_ran", runId: run.runId, workflow: run.workflow });
  }
}

/**
 * The workspace's newest running listener for the host, so pull requests keep going to the one a roll replaces until
 * the new one runs; else the newest still starting. One that never got a sidecar past its startup window is released.
 */
export async function liveListener(db: DB["db"], tenantId: string, source: RepoSource): Promise<LiveDeployment | undefined> {
  const now = new Date();
  let starting: LiveDeployment | undefined;
  for (const listener of await resolveLiveDeployments(db, tenantId, TRIAGE_LISTENERS[source])) {
    if (listener.cancelling) continue;
    const run = await managerRun(db, listener.runId);
    if (runIsRunning(run)) return listener;
    if (runIsUp(run, now, { graceMs: LISTENER_START_GRACE_MS, startedByMail: false })) starting ??= listener;
    else await releaseStuck(db, listener.runId, now, "listener deployed without a sidecar");
  }
  return starting;
}

/** The run id of the pull request's manager while that run is up and stock still lets it execute, so one being cancelled is mailed nothing. */
export async function liveManager(db: DB["db"], tenantId: string, pr: PullRequestRef): Promise<string | undefined> {
  return db.transaction(async function findLive(tx) {
    const now = new Date();
    const claim = await lockClaim(tx, tenantId, pr);
    if (claim?.status !== "live" || claim.runId === undefined) return undefined;
    const run = await managerRun(tx, claim.runId);
    return run && canExecuteWorkflowRun(run) && runIsUp(run, now, { startedByMail: true }) ? claim.runId : undefined;
  });
}

/**
 * The claim `runId` holds, taken for it when no up run holds it: it is missing or ended, or the run it names has gone,
 * whose open pass the caller resumes. Undefined while another up run holds it, a run being cancelled included until it
 * ends, or once stock no longer lets `runId` execute. Concurrent callers queue on the claim's row lock, so exactly one
 * takes it.
 */
async function claimFor(tx: Tx, tenantId: string, pr: PullRequestRef, runId: string): Promise<Claim | undefined> {
  const key = claimKey(pr);
  const now = new Date();
  const own = await managerRun(tx, runId);
  if (own && !canExecuteWorkflowRun(own)) return undefined;
  const fresh = { status: "live" as const, claimId: randomUUID(), claimedAt: now.toISOString(), runId };
  await tx.insert(managerState).values({ tenantId, key, kind: "claim", state: claimOf(key, { ...fresh, reviewers: [], history: [], starts: 1 }) }).onConflictDoNothing();
  const claim = await lockClaim(tx, tenantId, pr);
  if (!claim) throw new Error(`manager_state ${key} vanished under its lock`);
  if (claim.status === "live" && claim.runId === runId) return claim;
  if (claim.status === "live" && claim.runId !== undefined && !(await runGone(tx, claim.runId, now))) return undefined;
  if (claim.runId !== undefined && claim.runId !== runId) await releaseStuck(tx, claim.runId, now, "manager deployed without a sidecar or never ran");
  const taken = { ...claim, ...fresh, starts: claim.starts + 1 };
  await writeClaim(tx, tenantId, pr, taken);
  return taken;
}

/**
 * Since when the passes on `head` have waited for its CI: the first of them since the last pass on it that did not
 * wait, while the last one on it did.
 */
function waitingSince(history: Claim["history"], head: string): string | undefined {
  let since: string | undefined;
  for (const pass of history) {
    if (pass.head !== head) continue;
    since = pass.waiting ? since ?? pass.takenAt : undefined;
  }
  return since;
}

/**
 * The newest pull request mail, the claim's reviewers, when the calling run claimed the pull request, and for `head`,
 * the pass's or else that mail's, since when it has waited for its CI and when its first closed pass was taken.
 */
async function latest(tx: Tx, tenantId: string, pr: PullRequestRef, claim: Claim, head?: string): Promise<Latest> {
  const request = await newestRequest(tx, tenantId, pr);
  const named = head ?? request?.["headSha"];
  const since = typeof named === "string" ? waitingSince(claim.history, named) : undefined;
  const first = claim.history.find((pass) => pass.head === named)?.takenAt;
  return { ...(request && { request }), reviewers: claim.reviewers, claimedAt: claim.claimedAt, ...(since !== undefined && { waitingSince: since }), ...(first !== undefined && { headSince: first }) };
}

/** The newest pull request mail recorded for the pull request, or for its `head`, which triage runs on. */
async function newestRequest(tx: Tx, tenantId: string, pr: PullRequestRef, head?: string): Promise<Record<string, unknown> | undefined> {
  const prefix = eventPrefix(pr);
  const onHead = head === undefined ? undefined : sql`${managerState.state}->>'head' = ${head}`;
  const [row] = await tx.select({ key: managerState.key, state: managerState.state }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), sql`${managerState.kind} = 'event'`, like(managerState.key, `${prefix}%`), sql`${managerState.state}->'payload'->>'kind' = 'pr'`, onHead))
    .orderBy(desc(sql`${managerState.state}->>'receivedAt'`), desc(managerState.key))
    .limit(1);
  return row && eventOf(row.key, row.state).payload;
}

/** A code review the pull request's manager deployed: still out, what it reported, or that the manager gave up on it. */
export type CodeReviewRecord = { runId: string; head: string; at: string } & ({ state: "running" } | { state: "reported"; payload: Record<string, unknown> } | { state: "failed"; failed: string });

/**
 * The pull request's code reviews, newest first: each result a reviewer reported that a pass took or that names a
 * reviewer of the claim, and each reviewer the claim records without one, running until its deadline or failed as the
 * manager recorded it.
 */
export async function codeReviews(db: DB["db"], tenantId: string, pr: PullRequestRef): Promise<CodeReviewRecord[]> {
  const key = claimKey(pr);
  const [row] = await db.select({ state: managerState.state }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), eq(managerState.key, key), eq(managerState.kind, "claim")));
  if (!row) return [];
  const claim = claimOf(key, row.state);
  const reviewers = claim.reviewers.filter((reviewer) => reviewer.kind === "code-review");
  const taken = new Set([...claim.history.flatMap((pass) => pass.events), ...(claim.pass ? claim.pass.events : [])]);
  const named = new Set(reviewers.map((reviewer) => reviewer.runId));
  const prefix = eventKey(pr, "");
  const events = await db.select({ key: managerState.key, state: managerState.state }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), sql`${managerState.kind} = 'event'`, like(managerState.key, `${eventPrefix(pr)}%`), sql`${managerState.state}->>'type' = 'reviewer-result'`, sql`${managerState.state}->'payload'->>'kind' = 'code-review'`));
  const results = eventsOf(events).filter((result) => taken.has(result.key) || named.has(result.key.slice(prefix.length)));
  const records: CodeReviewRecord[] = results.map((result) => ({ runId: result.key.slice(prefix.length), head: result.event.head, at: result.event.receivedAt, state: "reported", payload: result.event.payload }));
  const reported = new Set(records.map((record) => record.runId));
  const pending = reviewers.filter((reviewer) => !reported.has(reviewer.runId));
  if (pending.length > 0) {
    const runs = await db.select({ id: schema.workflowRun.id, createdAt: schema.workflowRun.createdAt }).from(schema.workflowRun)
      .where(inArray(schema.workflowRun.id, pending.map((reviewer) => reviewer.runId)));
    for (const reviewer of pending) {
      // A reviewer's run outlives its claim record; one the store no longer holds has nothing to show.
      const run = runs.find((candidate) => candidate.id === reviewer.runId);
      if (!run) continue;
      const failed = asRecord(reviewer.result)?.["failed"];
      const base = { runId: reviewer.runId, head: reviewer.head, at: run.createdAt.toISOString() };
      if (typeof failed === "string") records.push({ ...base, state: "failed", failed });
      else if (reviewer.result === undefined && Date.parse(reviewer.deadline) > Date.now()) records.push({ ...base, state: "running" });
    }
  }
  return records.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Claims the pull request for `runId` when no live run holds it, then answers the open pass again, or a new one on the
 * newest head over every pending event no other transaction holds. Reviewer results for another head are consumed and
 * left out. Either way with the reviewers the last done recorded and the newest pull request mail recorded.
 */
export async function take(db: DB["db"], tenantId: string, pr: PullRequestRef, runId: string): Promise<TakeResult> {
  return db.transaction(async function takePending(tx) {
    const claim = await claimFor(tx, tenantId, pr, runId);
    if (!claim) return { outcome: "refused" };
    if (claim.pass) {
      const pass = { ...claim.pass, takes: claim.pass.takes + 1 };
      await writeClaim(tx, tenantId, pr, { ...claim, pass });
      const events = await eventsByKey(tx, tenantId, pass.events);
      return { outcome: "pass", pass, events, resumed: true, ...(await latest(tx, tenantId, pr, claim, pass.head)) };
    }
    const rows = await tx.select({ key: managerState.key, state: managerState.state }).from(managerState)
      .where(pending(tenantId, pr))
      .for("update", { skipLocked: true });
    const taken = eventsOf(rows);
    const head = passHeadOf(taken, claim.history);
    if (head === undefined) return { outcome: "idle", ...(await latest(tx, tenantId, pr, claim)) };
    const id = randomUUID();
    const takenAt = new Date().toISOString();
    await tx.update(managerState)
      .set({ state: sql`${managerState.state} || ${JSON.stringify({ consumedBy: id, consumedAt: takenAt })}::jsonb` })
      .where(and(eq(managerState.tenantId, tenantId), inArray(managerState.key, taken.map((row) => row.key))));
    const kept = taken.filter((row) => row.event.type === "webhook" || row.event.head === head);
    if (kept.length === 0) return { outcome: "idle", ...(await latest(tx, tenantId, pr, claim)) };
    const pass = { id, head, events: kept.map((row) => row.key), takenAt, takes: 1 };
    await writeClaim(tx, tenantId, pr, { ...claim, pass });
    return { outcome: "pass", pass, events: kept, resumed: false, ...(await latest(tx, tenantId, pr, claim, head)) };
  });
}

/**
 * The open pass closed by `runId`, with what it reported; a pass that reported without taking events, as one past a
 * reviewer's deadline, is closed as its own. One that triaged nothing, as one of approvals alone, leaves its head
 * waiting for CI as the pass before it did.
 */
function closing(claim: Claim, runId: string, now: Date, report: PassReport | undefined): ClosedPass | undefined {
  const at = now.toISOString();
  const pass = claim.pass ?? (report && { id: randomUUID(), head: report.head, events: [], takenAt: at, takes: 1 });
  if (!pass) return undefined;
  const waiting = report === undefined ? claim.history.findLast((closed) => closed.head === pass.head)?.waiting : report.waiting;
  return { ...pass, runId, doneAt: at, ...(waiting && { waiting: true }), ...(report?.request && { request: report.request }) };
}

/** The history with `closed` added; only the newest pass of a run on a head keeps a mirror request, the verdict that run's row now holds. */
function closedInto(history: Claim["history"], closed: ClosedPass): Claim["history"] {
  if (closed.request === undefined) return [...history, closed];
  const older = history.map(function withoutRequest(pass) {
    if (pass.runId !== closed.runId || pass.head !== closed.head) return pass;
    const { request: _request, ...rest } = pass;
    return rest;
  });
  return [...older, closed];
}

/** The reporting pass's closing: when this run first took `head`, and the newest pull request mail for it. */
async function closingOf(tx: Tx, tenantId: string, pr: PullRequestRef, runId: string, head: string, history: Claim["history"]): Promise<Closing> {
  const first = history.find((pass) => pass.runId === runId && pass.head === head);
  if (!first) throw new Error(`${claimKey(pr)} has no pass of ${runId} on ${head} to report`);
  const mail = await newestRequest(tx, tenantId, pr, head);
  return { head, startedAt: first.takenAt, ...(mail && { mail }) };
}

/** The claim's reviewers that ran past their deadline with no report and that `recorded` no longer waits for. */
async function givenUp(tx: Tx, tenantId: string, pr: PullRequestRef, claim: Claim, recorded: readonly Reviewer[], now: Date): Promise<Reviewer[]> {
  const late = claim.reviewers.filter((reviewer) => reviewer.result === undefined && Date.parse(reviewer.deadline) <= now.getTime() && !recorded.some((kept) => kept.runId === reviewer.runId && kept.result === undefined));
  if (late.length === 0) return [];
  const rows = await tx.select({ key: managerState.key }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), sql`${managerState.kind} = 'event'`, inArray(managerState.key, late.map((reviewer) => eventKey(pr, reviewer.runId)))));
  const reported = new Set(rows.map((row) => row.key));
  return late.filter((reviewer) => !reported.has(eventKey(pr, reviewer.runId)));
}

function reviewerKey({ kind, head, runId }: Reviewer): string {
  return `${kind}:${head}:${runId}`;
}

/**
 * Closes the open pass with what it reported and records `reviewers`. The manager has more to do while an event is
 * pending, at once, and once more after a pass that asks to `wait`; otherwise the claim ends, and a later event or
 * reviewer result starts the next manager. A reviewer the pass gave up on past its deadline with no report is logged.
 */
export async function done(db: DB["db"], tenantId: string, pr: PullRequestRef, runId: string, reviewers: readonly Reviewer[], { wait = false, report, record, log }: DoneOptions = {}): Promise<DoneResult> {
  return db.transaction(async function finishPass(tx) {
    const claim = await lockClaim(tx, tenantId, pr);
    if (!fencedTo(claim, runId)) return { outcome: "refused" };
    const recorded = ReviewerState.array()(asStored(reviewers));
    if (recorded instanceof type.errors) throw new Error(`reviewers for ${claimKey(pr)} are malformed: ${recorded.summary}`);
    const now = new Date();
    const closed = closing(claim, runId, now, report);
    const history = closed ? closedInto(claim.history, closed) : claim.history;
    const rows = await tx.select({ key: managerState.key, state: managerState.state }).from(managerState).where(pending(tenantId, pr));
    const waiting = passHeadOf(eventsOf(rows), history) !== undefined;
    const kept = { claimId: claim.claimId, claimedAt: claim.claimedAt, reviewers: recorded, history, starts: claim.starts };
    if (record) await record(tx, report && await closingOf(tx, tenantId, pr, runId, report.head, history));
    for (const reviewer of await givenUp(tx, tenantId, pr, claim, recorded, now)) {
      log?.({ level: "warn", msg: "reviewer_overdue", tenantId, source: pr.source, repo: pr.repo, number: pr.number, kind: reviewer.kind, head: reviewer.head, runId: reviewer.runId, deadline: reviewer.deadline });
    }
    if (waiting || wait) {
      await writeClaim(tx, tenantId, pr, { ...kept, status: "live", runId });
      return { outcome: "more", wait: !waiting };
    }
    await writeClaim(tx, tenantId, pr, { ...kept, status: "ended" });
    return { outcome: "ended" };
  });
}

/** The mirror request of the verdict `runId` posted on `head`, which approving one of its held Dos sends again. */
export async function passRequest(db: DB["db"], tenantId: string, pr: PullRequestRef, runId: string, head: string): Promise<Record<string, unknown> | undefined> {
  const key = claimKey(pr);
  const [row] = await db.select({ state: managerState.state }).from(managerState).where(and(eq(managerState.tenantId, tenantId), eq(managerState.key, key), eq(managerState.kind, "claim")));
  return row && claimOf(key, row.state).history.findLast((pass) => pass.runId === runId && pass.head === head && pass.request !== undefined)?.request;
}

/**
 * A pull request a manager claimed: its closed passes; while its manager is up, that run, the head of the newest pull
 * request mail recorded, the pass it has open, since when it has waited for that head's CI and what its reviewers on
 * that head have yet to report before their deadlines; and the pass a manager that went away left open.
 */
export type ManagedPull = { pr: PullRequestRef; history: ClosedPass[]; live?: { runId: string; head?: string; pass?: Pass; waitingSince?: string; awaiting: AwaitedStage[] }; gone?: { runId: string; pass: Pass } };

function awaitedOn(reviewers: readonly Reviewer[], head: string | undefined, now: Date): AwaitedStage[] {
  return AWAITED_STAGES.filter((kind) => reviewers.some((reviewer) => reviewer.kind === kind && reviewer.head === head && reviewer.result === undefined && Date.parse(reviewer.deadline) > now.getTime()));
}

/** The pull request's mails that name its head: its webhooks other than a held Do's approval. */
function mails(tenantId: string, pr: PullRequestRef): SQL | undefined {
  return and(eq(managerState.tenantId, tenantId), sql`${managerState.kind} = 'event'`, like(managerState.key, `${eventPrefix(pr)}%`), sql`${managerState.state}->>'type' = 'webhook'`, sql`${managerState.state}->'payload'->>'kind' IS DISTINCT FROM ${APPROVE_DO_KIND}`);
}

const newestFirst = sql`${managerState.state}->>'receivedAt' DESC, ${managerState.key} DESC`;

/** The newest head a pull request mail named, which a live manager takes next or has taken; undefined before any. */
async function newestHead(tx: Tx | DB["db"], tenantId: string, pr: PullRequestRef): Promise<string | undefined> {
  const [row] = await tx.select({ key: managerState.key, state: managerState.state }).from(managerState)
    .where(mails(tenantId, pr))
    .orderBy(newestFirst)
    .limit(1);
  return row && eventOf(row.key, row.state).head;
}

/** The claim's reviewers still out on a head older than the newest one a pull request mail named, which no manager waits for any more. */
export async function superseded(db: DB["db"], tenantId: string, pr: PullRequestRef): Promise<Reviewer[]> {
  return db.transaction(async function older(tx) {
    const claim = await lockClaim(tx, tenantId, pr);
    const head = await newestHead(tx, tenantId, pr);
    if (!claim || head === undefined) return [];
    return claim.reviewers.filter((reviewer) => reviewer.head !== head && reviewer.result === undefined);
  });
}

/** Takes the reviewer off the claim, once its run was asked to stop. */
export async function dropReviewer(db: DB["db"], tenantId: string, pr: PullRequestRef, reviewer: Reviewer): Promise<void> {
  await db.transaction(async function drop(tx) {
    const claim = await lockClaim(tx, tenantId, pr);
    if (!claim) return;
    const key = reviewerKey(reviewer);
    await writeClaim(tx, tenantId, pr, { ...claim, reviewers: claim.reviewers.filter((held) => reviewerKey(held) !== key) });
  });
}

const CLAIM_KEY = /^mgr:([^:]+):(.+)#(\d+)$/;

function pullOf(key: string): PullRequestRef {
  const [, source, repo, number] = CLAIM_KEY.exec(key) ?? [];
  const known = REPO_SOURCES.find((each) => each === source);
  if (!known || repo === undefined || number === undefined) throw new Error(`manager_state ${key} is not a claim key`);
  return { source: known, repo, number: Number(number) };
}

/** How long an overdue wake no manager has taken the claim since holds off the next, while its manager may still be reaching a sidecar. */
const OVERDUE_UNSTARTED_GRACE_MS = 30 * 60_000;

/** Whether the claim's last overdue wake is still within its grace: a manager took the claim since, or none has yet. */
function recentlyWoken(claim: Claim, now: Date): boolean {
  if (claim.overdueWokenAt === undefined) return false;
  const woken = Date.parse(claim.overdueWokenAt);
  const grace = Date.parse(claim.claimedAt) >= woken ? MANAGER_START_GRACE_MS : OVERDUE_UNSTARTED_GRACE_MS;
  return now.getTime() - woken < grace;
}

/** Records on the claim that the hub woke a manager for an overdue reviewer, so the next reconcile pass holds off. */
export async function recordOverdueWake(db: DB["db"], tenantId: string, pr: PullRequestRef): Promise<void> {
  await db.transaction(async function wokenAt(tx) {
    const claim = await lockClaim(tx, tenantId, pr);
    if (!claim) throw new Error(`${claimKey(pr)} has no claim to wake`);
    await writeClaim(tx, tenantId, pr, { ...claim, overdueWokenAt: new Date().toISOString() });
  });
}

const NewestTakes = type({ tenantId: "string", source: "string", at: "string" }).array();

/** When a manager of each tenant and host last opened a pass on a pull request. Read once, as the hub starts. */
export async function lastTakes(db: DB["db"]): Promise<{ tenantId: string; source: RepoSource; at: string }[]> {
  const rows = NewestTakes.assert(await db.execute(sql`
    SELECT ${managerState.tenantId} AS "tenantId", split_part(${managerState.key}, ':', 2) AS source, max(taken.at) AS at FROM ${managerState},
    LATERAL (VALUES (${managerState.state}->'pass'->>'takenAt'), (${managerState.state}->'history'->-1->>'takenAt')) AS taken(at)
    WHERE ${managerState.kind} = 'claim' AND taken.at IS NOT NULL
    GROUP BY 1, 2`));
  return rows.flatMap(function known(row) {
    const source = REPO_SOURCES.find((each) => each === row.source);
    return source === undefined ? [] : [{ tenantId: row.tenantId, source, at: row.at }];
  });
}

/** When the oldest pull request mail of the tenant's host that no manager has taken was recorded, among those recorded after `after`. */
export async function oldestPendingMail(db: DB["db"], tenantId: string, source: RepoSource, after: string | undefined): Promise<string | undefined> {
  const since = after === undefined ? undefined : sql`(${managerState.state}->>'receivedAt')::timestamptz > ${after}::timestamptz`;
  const ofHost = like(managerState.key, `evt:${source}:%`);
  const [row] = await db.select({ at: sql<string | null>`min(${managerState.state}->>'receivedAt')` }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), sql`${managerState.kind} = 'event'`, sql`${managerState.state}->>'consumedBy' IS NULL`, sql`${managerState.state}->>'type' = 'webhook'`, ofHost, since));
  return row?.at ?? undefined;
}

/** The tenant's pull requests whose claim holds a reviewer with no result. */
export async function reviewedPulls(db: DB["db"], tenantId: string): Promise<PullRequestRef[]> {
  const rows = await db.select({ key: managerState.key }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), eq(managerState.kind, "claim"), sql`jsonb_path_exists(${managerState.state}, '$.reviewers[*] ? (!(exists(@.result)))')`));
  return rows.map((row) => pullOf(row.key));
}

/** Each claim with a reviewer result recorded that no pass has taken, with its newest such result. */
async function unreadResults(db: DB["db"], tenantId: string): Promise<Map<string, ManagerEvent>> {
  const rows = await db.select({ key: managerState.key, state: managerState.state }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), sql`${managerState.kind} = 'event'`, sql`${managerState.state}->>'consumedBy' IS NULL`, sql`${managerState.state}->>'type' = 'reviewer-result'`));
  // A result's key is its pull request's event prefix and the reporting run's id, which has no colon.
  return new Map(eventsOf(rows).map((row) => [`mgr:${row.key.slice("evt:".length, row.key.lastIndexOf(":"))}`, row.event]));
}

/**
 * The tenant's pull requests whose manager has gone, with the head to wake one on: each with a reviewer result no pass
 * has taken, as when waking a manager for it failed, once the manager start grace has passed since that result, so a
 * manager its own wake deployed is not deployed again while it starts; and each whose reviewer of its newest head is past
 * its deadline with no result recorded, so a manager posts its verdict without the reviewer. Either is skipped while the
 * claim's last overdue wake is within its grace.
 */
export async function overduePulls(db: DB["db"], tenantId: string): Promise<{ pr: PullRequestRef; head: string }[]> {
  const now = new Date();
  const unread = await unreadResults(db, tenantId);
  const late = sql`jsonb_path_exists(${managerState.state}, '$.reviewers[*] ? (!(exists(@.result)) && @.deadline <= $now)', jsonb_build_object('now', ${now.toISOString()}::text))`;
  const rows = await db.select({ key: managerState.key, state: managerState.state }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), eq(managerState.kind, "claim"), unread.size === 0 ? late : or(late, inArray(managerState.key, [...unread.keys()]))));
  const overdue: { pr: PullRequestRef; head: string }[] = [];
  for (const { key, state } of rows) {
    const claim = claimOf(key, state);
    const pr = pullOf(key);
    if (recentlyWoken(claim, now) || (claim.status === "live" && claim.runId !== undefined && !(await runGone(db, claim.runId, now)))) continue;
    const head = await newestHead(db, tenantId, pr);
    const result = unread.get(key);
    if (result !== undefined) {
      if (now.getTime() - Date.parse(result.receivedAt) >= MANAGER_START_GRACE_MS) overdue.push({ pr, head: head ?? result.head });
      continue;
    }
    if (head === undefined) continue;
    const pastDeadline = claim.reviewers.filter((reviewer) => reviewer.head === head && reviewer.result === undefined && Date.parse(reviewer.deadline) <= now.getTime());
    if (pastDeadline.length === 0) continue;
    const reported = await db.select({ key: managerState.key }).from(managerState)
      .where(and(eq(managerState.tenantId, tenantId), sql`${managerState.kind} = 'event'`, inArray(managerState.key, pastDeadline.map((reviewer) => eventKey(pr, reviewer.runId)))));
    if (reported.length < pastDeadline.length) overdue.push({ pr, head });
  }
  return overdue;
}

/** The claims of `pulls` a manager made. */
export async function managedPulls(db: DB["db"], tenantId: string, pulls: readonly PullRequestRef[]): Promise<ManagedPull[]> {
  if (pulls.length === 0) return [];
  return db.transaction(async function readClaims(tx) {
    const now = new Date();
    const byKey = new Map(pulls.map((pr) => [claimKey(pr), pr]));
    const rows = await tx.select({ key: managerState.key, state: managerState.state }).from(managerState)
      .where(and(eq(managerState.tenantId, tenantId), eq(managerState.kind, "claim"), inArray(managerState.key, [...byKey.keys()])));
    const managed: ManagedPull[] = [];
    for (const { key, state } of rows) {
      const claim = claimOf(key, state);
      const pr = byKey.get(key);
      if (!pr) throw new Error(`manager_state ${key} is not a claim asked for`);
      const runId = claim.status === "live" ? claim.runId : undefined;
      if (runId === undefined) {
        managed.push({ pr, history: claim.history });
      } else if (await runGone(tx, runId, now)) {
        managed.push({ pr, history: claim.history, ...(claim.pass && { gone: { runId, pass: claim.pass } }) });
      } else {
        const head = await newestHead(tx, tenantId, pr);
        const since = head === undefined ? undefined : waitingSince(claim.history, head);
        managed.push({ pr, history: claim.history, live: { runId, ...(head !== undefined && { head }), ...(claim.pass && { pass: claim.pass }), ...(since !== undefined && { waitingSince: since }), awaiting: awaitedOn(claim.reviewers, head, now) } });
      }
    }
    return managed;
  });
}
