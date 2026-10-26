// A pull request's manager claim and the events waiting for it, one `manager_state` row each. A manager's take claims the
// pull request when no live run holds it, and done checks for pending events under the claim's lock, so an event is
// either taken by the live manager or by the next one. Only the run the claim names takes events or finishes a pass.
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { jsonb, primaryKey, text } from "drizzle-orm/pg-core";
import { type } from "arktype";
import { schema, type DB } from "@intx/db";
import { APPROVE_DO_KIND, type RepoSource } from "@corbits/triage-contracts";
import type { Tx } from "./github/admin-github-grant.js";
import { triageSchema } from "./triage-db.js";

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

type Latest = { request?: Record<string, unknown>; reviewers: Reviewer[] };
type TakeResult = { outcome: "refused" } | ({ outcome: "idle" } & Latest) | ({ outcome: "pass"; pass: Pass; events: TakenEvent[]; resumed: boolean } & Latest);
type ClosedPass = Claim["history"][number];
/** What a pass reports as done closes it: the head it worked on, held for CI, or the mirror request of the verdict it posted. */
export type PassReport = { head: string; waiting?: true; request?: Record<string, unknown> };
/** `closed` is the pass done closed, and `mail` the newest pull request mail, when the pass reported. */
type Closing = { closed?: ClosedPass; mail?: Record<string, unknown> };
type DoneResult = { outcome: "refused" } | (({ outcome: "ended" } | { outcome: "more"; wait: boolean }) & Closing);

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

/** `text` as a LIKE pattern's literal prefix. */
function likePrefix(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

/** The pull request's event keys' prefix as a LIKE pattern. */
function eventPrefix(pr: PullRequestRef): string {
  return likePrefix(eventKey(pr, ""));
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

/** Records the event under its delivery id; false when it was recorded before, as on a redelivery. */
export async function recordEvent(db: DB["db"], tenantId: string, pr: PullRequestRef, deliveryId: string, event: Pick<ManagerEvent, "type" | "head" | "payload">): Promise<boolean> {
  if (deliveryId.length === 0) throw new Error(`an event for ${claimKey(pr)} has no delivery id`);
  const key = eventKey(pr, deliveryId);
  const fields = NewEvent(asStored({ type: event.type, head: event.head, payload: event.payload }));
  if (fields instanceof type.errors) throw new Error(`manager_state ${key} is not an event: ${fields.summary}`);
  // Stamped by the database to the microsecond as it inserts the row, so events sort in the order they were recorded.
  const state = sql`${JSON.stringify(fields)}::jsonb || jsonb_build_object('receivedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`;
  const inserted = await db.insert(managerState).values({ tenantId, key, kind: "event", state }).onConflictDoNothing().returning({ key: managerState.key });
  return inserted.length === 1;
}

/** How long a just-deployed manager may have no sidecar and still hold the pull request. The listener waits this long for it to start. */
const MANAGER_START_GRACE_MS = 2 * 60_000;

type ManagerRun = { status: string; createdAt: Date; allocationStatus: string | null; sidecarId: string | null };

async function managerRun(tx: Tx, runId: string): Promise<ManagerRun | undefined> {
  const [run] = await tx
    .select({
      status: schema.workflowRun.status,
      createdAt: schema.workflowRun.createdAt,
      allocationStatus: schema.sidecarAllocation.status,
      sidecarId: schema.sidecarAllocation.sidecarId,
    })
    .from(schema.workflowRun)
    .leftJoin(schema.sidecarAllocation, eq(schema.sidecarAllocation.anchorRunId, schema.workflowRun.id))
    .where(eq(schema.workflowRun.id, runId));
  return run;
}

/** A running manager, one whose sidecar is up, or one deployed inside the startup window. A deploy that never got a sidecar past that window is not. */
function runIsUp(run: ManagerRun | undefined, now: Date): boolean {
  if (!run || !schema.isLiveWorkflowRunStatus(run.status)) return false;
  if (run.status === "running") return true;
  if (run.allocationStatus === "allocated" && run.sidecarId !== null) return true;
  return now.getTime() - run.createdAt.getTime() < MANAGER_START_GRACE_MS;
}

async function runGone(tx: Tx, runId: string, now: Date): Promise<boolean> {
  return !runIsUp(await managerRun(tx, runId), now);
}

/** Asks the sweep to stop a deploy that still counts as live but never became a process, so it cannot start after its claim has moved on. */
async function releaseStuck(tx: Tx, runId: string, now: Date): Promise<void> {
  await tx
    .update(schema.workflowRun)
    .set({ cancellationRequestedAt: now, cancellationDeadline: now, cancellationReason: "manager deployed without a sidecar" })
    .where(and(eq(schema.workflowRun.id, runId), inArray(schema.workflowRun.status, [...schema.liveWorkflowRunStatuses]), isNull(schema.workflowRun.cancellationRequestedAt)));
}

/** The run id of the pull request's manager while that run is up. */
export async function liveManager(db: DB["db"], tenantId: string, pr: PullRequestRef): Promise<string | undefined> {
  return db.transaction(async function findLive(tx) {
    const now = new Date();
    const claim = await lockClaim(tx, tenantId, pr);
    if (claim?.status !== "live" || claim.runId === undefined) return undefined;
    return (await runGone(tx, claim.runId, now)) ? undefined : claim.runId;
  });
}

/**
 * The claim `runId` holds, taken for it when no up run holds it: it is missing or ended, or the run it names has gone,
 * whose open pass the caller resumes. Undefined while another up run holds it. Concurrent callers queue on the
 * claim's row lock, so exactly one takes it.
 */
async function claimFor(tx: Tx, tenantId: string, pr: PullRequestRef, runId: string): Promise<Claim | undefined> {
  const key = claimKey(pr);
  const now = new Date();
  const fresh = { status: "live" as const, claimId: randomUUID(), claimedAt: now.toISOString(), runId };
  await tx.insert(managerState).values({ tenantId, key, kind: "claim", state: claimOf(key, { ...fresh, reviewers: [], history: [], starts: 1 }) }).onConflictDoNothing();
  const claim = await lockClaim(tx, tenantId, pr);
  if (!claim) throw new Error(`manager_state ${key} vanished under its lock`);
  if (claim.status === "live" && claim.runId === runId) return claim;
  if (claim.status === "live" && claim.runId !== undefined && !(await runGone(tx, claim.runId, now))) return undefined;
  if (claim.runId !== undefined && claim.runId !== runId) await releaseStuck(tx, claim.runId, now);
  const taken = { ...claim, ...fresh, starts: claim.starts + 1 };
  await writeClaim(tx, tenantId, pr, taken);
  return taken;
}

async function latest(tx: Tx, tenantId: string, pr: PullRequestRef, claim: Claim): Promise<Latest> {
  const request = await newestRequest(tx, tenantId, pr);
  return { ...(request && { request }), reviewers: claim.reviewers };
}

/** The newest pull request mail recorded for the pull request, which triage runs on. */
async function newestRequest(tx: Tx, tenantId: string, pr: PullRequestRef): Promise<Record<string, unknown> | undefined> {
  const prefix = eventPrefix(pr);
  const [row] = await tx.select({ key: managerState.key, state: managerState.state }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), sql`${managerState.kind} = 'event'`, like(managerState.key, `${prefix}%`), sql`${managerState.state}->'payload'->>'kind' = 'pr'`))
    .orderBy(desc(sql`${managerState.state}->>'receivedAt'`), desc(managerState.key))
    .limit(1);
  return row && eventOf(row.key, row.state).payload;
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
      return { outcome: "pass", pass, events, resumed: true, ...(await latest(tx, tenantId, pr, claim)) };
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
    return { outcome: "pass", pass, events: kept, resumed: false, ...(await latest(tx, tenantId, pr, claim)) };
  });
}

/** The open pass closed by `runId`, with what it reported; a pass that reported without taking events, as one past a reviewer's deadline, is closed as its own. */
function closing(claim: Claim, runId: string, now: Date, report: PassReport | undefined): ClosedPass | undefined {
  const at = now.toISOString();
  const pass = claim.pass ?? (report && { id: randomUUID(), head: report.head, events: [], takenAt: at, takes: 1 });
  return pass && { ...pass, runId, doneAt: at, ...(report?.waiting && { waiting: true }), ...(report?.request && { request: report.request }) };
}

/**
 * Closes the open pass with what it reported and records `reviewers`. The claim ends when no event is pending and no
 * reviewer of the current head is still due; otherwise the manager has more to do: at once when an event is pending,
 * else after it waits for its reviewer.
 */
export async function done(db: DB["db"], tenantId: string, pr: PullRequestRef, runId: string, reviewers: readonly Reviewer[], report?: PassReport): Promise<DoneResult> {
  return db.transaction(async function finishPass(tx) {
    const claim = await lockClaim(tx, tenantId, pr);
    if (!fencedTo(claim, runId)) return { outcome: "refused" };
    const recorded = ReviewerState.array()(asStored(reviewers));
    if (recorded instanceof type.errors) throw new Error(`reviewers for ${claimKey(pr)} are malformed: ${recorded.summary}`);
    const now = new Date();
    const closed = closing(claim, runId, now, report);
    const history = closed ? [...claim.history, closed] : claim.history;
    const mail = report && await newestRequest(tx, tenantId, pr);
    const reported: Closing = report && closed ? { closed, ...(mail && { mail }) } : {};
    const head = history.at(-1)?.head;
    const due = recorded.some((reviewer) => reviewer.head === head && reviewer.result === undefined && Date.parse(reviewer.deadline) > now.getTime());
    const rows = await tx.select({ key: managerState.key, state: managerState.state }).from(managerState).where(pending(tenantId, pr));
    const waiting = passHeadOf(eventsOf(rows), history) !== undefined;
    const kept = { claimId: claim.claimId, claimedAt: claim.claimedAt, reviewers: recorded, history, starts: claim.starts };
    if (due || waiting) {
      await writeClaim(tx, tenantId, pr, { ...kept, status: "live", runId });
      return { outcome: "more", wait: !waiting, ...reported };
    }
    await writeClaim(tx, tenantId, pr, { ...kept, status: "ended" });
    return { outcome: "ended", ...reported };
  });
}

/** The mirror request of the verdict `runId` posted on `head`, which approving one of its held Dos sends again. */
export async function passRequest(db: DB["db"], tenantId: string, pr: PullRequestRef, runId: string, head: string): Promise<Record<string, unknown> | undefined> {
  const key = claimKey(pr);
  const [row] = await db.select({ state: managerState.state }).from(managerState).where(and(eq(managerState.tenantId, tenantId), eq(managerState.key, key), eq(managerState.kind, "claim")));
  return row && claimOf(key, row.state).history.findLast((pass) => pass.runId === runId && pass.head === head && pass.request !== undefined)?.request;
}

/** A pull request a manager claimed: its closed passes, and while its manager is up, that run and the head of the newest pull request mail recorded. */
export type ManagedPull = { pr: PullRequestRef; history: ClosedPass[]; live?: { runId: string; head?: string } };

/** The newest head a pull request mail named, which a live manager takes next or has taken. */
async function newestHead(tx: Tx, tenantId: string, pr: PullRequestRef): Promise<string | undefined> {
  const [row] = await tx.select({ key: managerState.key, state: managerState.state }).from(managerState)
    .where(and(eq(managerState.tenantId, tenantId), sql`${managerState.kind} = 'event'`, like(managerState.key, `${eventPrefix(pr)}%`), sql`${managerState.state}->>'type' = 'webhook'`, sql`${managerState.state}->'payload'->>'kind' IS DISTINCT FROM ${APPROVE_DO_KIND}`))
    .orderBy(desc(sql`${managerState.state}->>'receivedAt'`), desc(managerState.key))
    .limit(1);
  return row && eventOf(row.key, row.state).head;
}

/** Every pull request of the host a manager claimed in the tenant. */
export async function managedPulls(db: DB["db"], tenantId: string, source: RepoSource): Promise<ManagedPull[]> {
  return db.transaction(async function readClaims(tx) {
    const now = new Date();
    const prefix = `mgr:${source}:`;
    const rows = await tx.select({ key: managerState.key, state: managerState.state }).from(managerState)
      .where(and(eq(managerState.tenantId, tenantId), eq(managerState.kind, "claim"), like(managerState.key, `${likePrefix(prefix)}%`)));
    const pulls: ManagedPull[] = [];
    for (const { key, state } of rows) {
      const claim = claimOf(key, state);
      const name = key.slice(prefix.length);
      const at = name.lastIndexOf("#");
      const pr = { source, repo: name.slice(0, at), number: Number(name.slice(at + 1)) };
      const runId = claim.status === "live" ? claim.runId : undefined;
      if (runId === undefined || (await runGone(tx, runId, now))) {
        pulls.push({ pr, history: claim.history });
        continue;
      }
      const head = await newestHead(tx, tenantId, pr);
      pulls.push({ pr, history: claim.history, live: { runId, ...(head !== undefined && { head }) } });
    }
    return pulls;
  });
}
