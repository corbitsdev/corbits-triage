// A pull request's manager claim and the events waiting for it, one `manager_state` row each. Intake commits its event
// before it touches the claim, and done checks for pending events under the claim's lock, so an event is either taken
// by the live manager or starts a new one. Only the run the claim names takes events or finishes a pass.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { jsonb, primaryKey, text } from "drizzle-orm/pg-core";
import { type } from "arktype";
import type { DB } from "@intx/db";
import type { RepoSource } from "@corbits/triage-contracts";
import type { Tx } from "./github/admin-github-grant.js";
import { triageSchema } from "./triage-db.js";

const managerState = triageSchema.table("manager_state", {
  tenantId: text("tenant_id").notNull(),
  key: text("key").notNull(),
  kind: text("kind").$type<"claim" | "event">().notNull(),
  state: jsonb("state").notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.key] })]);

export const PassState = type({ id: "string > 0", head: "string > 0", events: "string[]", takenAt: "string.date.iso", takes: "number.integer >= 1" });
export const ReviewerState = type({ kind: "string > 0", head: "string > 0", runId: "string > 0", deadline: "string.date.iso", "result?": "string | number | boolean | object" });
const ClaimState = type({
  status: "'starting' | 'live' | 'ended'",
  claimId: "string > 0",
  claimedAt: "string.date.iso",
  "runId?": "string > 0",
  "pass?": PassState,
  reviewers: ReviewerState.array(),
  history: PassState.and({ runId: "string > 0", doneAt: "string.date.iso" }).array(),
  starts: "number.integer >= 0",
});
export const EventPayload = type("Record<string, unknown>").narrow(function plainObject(value) {
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
export type PullRequestRef = { source: RepoSource; repo: string; number: number };
type TakenEvent = { key: string; event: ManagerEvent };

type IntakeClaim = { outcome: "won"; claimId: string } | { outcome: "live"; runId: string } | { outcome: "starting" };
type TakeResult = { outcome: "refused" } | { outcome: "idle" } | { outcome: "pass"; pass: Pass; events: TakenEvent[]; resumed: boolean };
type DoneResult = { outcome: "refused" } | { outcome: "ended" } | { outcome: "more" };

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

/** The kind is a literal so a generic plan still matches the partial index. */
function pending(tenantId: string, pr: PullRequestRef) {
  const prefix = eventKey(pr, "").replace(/[\\%_]/g, "\\$&");
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
function headOf(taken: readonly TakenEvent[], claim: Claim): string | undefined {
  return taken.findLast((row) => row.event.type === "webhook")?.event.head ?? claim.history.at(-1)?.head;
}

/** Records the event under its delivery id; false when it was recorded before, as on a redelivery. */
export async function recordEvent(db: DB["db"], tenantId: string, pr: PullRequestRef, deliveryId: string, event: Pick<ManagerEvent, "type" | "head" | "payload">): Promise<boolean> {
  if (deliveryId.length === 0) throw new Error(`an event for ${claimKey(pr)} has no delivery id`);
  const key = eventKey(pr, deliveryId);
  const state = eventOf(key, asStored({ type: event.type, head: event.head, payload: event.payload, receivedAt: new Date().toISOString() }));
  const inserted = await db.insert(managerState).values({ tenantId, key, kind: "event", state }).onConflictDoNothing().returning({ key: managerState.key });
  return inserted.length === 1;
}

/** Called after `recordEvent` commits. Exactly one caller wins a claim that is missing or ended; its history carries over. */
export async function claimForIntake(db: DB["db"], tenantId: string, pr: PullRequestRef): Promise<IntakeClaim> {
  const key = claimKey(pr);
  const fresh = { status: "starting" as const, claimId: randomUUID(), claimedAt: new Date().toISOString() };
  return db.transaction(async function claim(tx) {
    const won = await tx.insert(managerState)
      .values({ tenantId, key, kind: "claim", state: claimOf(key, { ...fresh, reviewers: [], history: [], starts: 0 }) })
      .onConflictDoUpdate({
        target: [managerState.tenantId, managerState.key],
        set: { state: sql`(${managerState.state} - 'runId') || ${JSON.stringify(fresh)}::jsonb` },
        setWhere: sql`${managerState.state}->>'status' = 'ended'`,
      })
      .returning({ state: managerState.state });
    if (won.length === 1) return { outcome: "won", claimId: claimOf(key, won[0].state).claimId };
    const current = await lockClaim(tx, tenantId, pr);
    if (current?.status === "live" && current.runId !== undefined) return { outcome: "live", runId: current.runId };
    if (current?.status === "starting") return { outcome: "starting" };
    throw new Error(`manager_state ${key} was refused to intake but is ${current?.status ?? "missing"}`);
  });
}

/** Names `runId` as the manager, only while the claim is still the one `claimId` won. */
export async function markLive(db: DB["db"], tenantId: string, pr: PullRequestRef, claimId: string, runId: string): Promise<boolean> {
  return db.transaction(async function live(tx) {
    const claim = await lockClaim(tx, tenantId, pr);
    if (claim?.status !== "starting" || claim.claimId !== claimId) return false;
    await writeClaim(tx, tenantId, pr, { ...claim, status: "live", runId, starts: claim.starts + 1 });
    return true;
  });
}

/**
 * The open pass again, or a new one on the newest head over every pending event no other transaction holds. Reviewer
 * results for another head are consumed and left out.
 */
export async function take(db: DB["db"], tenantId: string, pr: PullRequestRef, runId: string): Promise<TakeResult> {
  return db.transaction(async function takePending(tx) {
    const claim = await lockClaim(tx, tenantId, pr);
    if (!fencedTo(claim, runId)) return { outcome: "refused" };
    if (claim.pass) {
      const pass = { ...claim.pass, takes: claim.pass.takes + 1 };
      await writeClaim(tx, tenantId, pr, { ...claim, pass });
      return { outcome: "pass", pass, events: await eventsByKey(tx, tenantId, pass.events), resumed: true };
    }
    const rows = await tx.select({ key: managerState.key, state: managerState.state }).from(managerState)
      .where(pending(tenantId, pr))
      .for("update", { skipLocked: true });
    const taken = eventsOf(rows);
    if (taken.length === 0) return { outcome: "idle" };
    const id = randomUUID();
    const takenAt = new Date().toISOString();
    await tx.update(managerState)
      .set({ state: sql`${managerState.state} || ${JSON.stringify({ consumedBy: id, consumedAt: takenAt })}::jsonb` })
      .where(and(eq(managerState.tenantId, tenantId), inArray(managerState.key, taken.map((row) => row.key))));
    const head = headOf(taken, claim);
    const kept = taken.filter((row) => row.event.type === "webhook" || row.event.head === head);
    if (head === undefined || kept.length === 0) return { outcome: "idle" };
    const pass = { id, head, events: kept.map((row) => row.key), takenAt, takes: 1 };
    await writeClaim(tx, tenantId, pr, { ...claim, pass });
    return { outcome: "pass", pass, events: kept, resumed: false };
  });
}

/**
 * Closes the open pass and records `reviewers`. The claim ends when no event is pending and no reviewer of the current
 * head is still due; otherwise the manager has more to do.
 */
export async function done(db: DB["db"], tenantId: string, pr: PullRequestRef, runId: string, reviewers: readonly Reviewer[]): Promise<DoneResult> {
  return db.transaction(async function finishPass(tx) {
    const claim = await lockClaim(tx, tenantId, pr);
    if (!fencedTo(claim, runId)) return { outcome: "refused" };
    const recorded = ReviewerState.array()(asStored(reviewers));
    if (recorded instanceof type.errors) throw new Error(`reviewers for ${claimKey(pr)} are malformed: ${recorded.summary}`);
    const now = new Date();
    const history = claim.pass ? [...claim.history, { ...claim.pass, runId, doneAt: now.toISOString() }] : claim.history;
    const head = history.at(-1)?.head;
    const due = recorded.some((reviewer) => reviewer.head === head && reviewer.result === undefined && Date.parse(reviewer.deadline) > now.getTime());
    const waiting = !due && (await tx.select({ key: managerState.key }).from(managerState).where(pending(tenantId, pr)).limit(1)).length > 0;
    const closed = { claimId: claim.claimId, claimedAt: claim.claimedAt, reviewers: recorded, history, starts: claim.starts };
    if (due || waiting) {
      await writeClaim(tx, tenantId, pr, { ...closed, status: "live", runId });
      return { outcome: "more" };
    }
    await writeClaim(tx, tenantId, pr, { ...closed, status: "ended" });
    return { outcome: "ended" };
  });
}
