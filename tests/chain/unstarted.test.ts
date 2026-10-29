// A manager the listener mails before its deploy is recorded, which stock holds the mail for.
import { expect, test } from "bun:test";
import { cleanup, MAIL_HOLD_MS } from "./stack.ts";
import { chainStack, isLiveDeployment, once, SETTLE_MS, UNSTARTED, type Claim } from "./chain.ts";
import { comments, pullOf, sha, type Write } from "./github.ts";

const stack = chainStack();
const { github, pushed, eachRunEvent, until, rows, managers, settled } = stack;

// Stock drops the failed manager's wake mail once the hold lapses, measured from when it parked the mail.
const DROPPED_MS = MAIL_HOLD_MS + SETTLE_MS;

/** How many wake mails the listener has sent. */
async function wakes(): Promise<number> {
  let sent = 0;
  await eachRunEvent(function count(_runId, { type, body }) {
    if (type === "StepCompleted" && /^mail(\[\d+\])?$/.test(String(body["stepId"]))) sent += 1;
  });
  return sent;
}

async function publicKeyOf(runId: string): Promise<string | null> {
  const [run] = await rows(`select public_key from workflow_run where id = '${runId}'`);
  return (run?.["public_key"] ?? null) as string | null;
}

/** Holds back the deploy record of every run deployed from now on until `recordKeys`, as a slow deploy ack would. */
async function holdKeys(): Promise<void> {
  await rows("create table chain_keys_released (at timestamptz)");
  await rows("create function chain_hold_key() returns trigger language plpgsql as $$ begin while not exists (select 1 from chain_keys_released) loop perform pg_sleep(0.1); end loop; return new; end $$");
  await rows(`create trigger chain_hold_key before update of public_key on workflow_run for each row when (new.created_at > '${new Date().toISOString()}') execute function chain_hold_key()`);
}

async function recordKeys(): Promise<void> {
  await rows("insert into chain_keys_released values (now())");
}

async function dropHold(): Promise<void> {
  await rows("drop trigger if exists chain_hold_key on workflow_run");
  await rows("drop function if exists chain_hold_key()");
  await rows("drop table if exists chain_keys_released");
}

/** Fails the deploy record of every run deployed from now on, until `refuseUntil` names a time, as a deploy that fails would. */
async function refuseKeys(): Promise<void> {
  await rows("create table chain_refuse_until (until timestamptz)");
  await rows("create function chain_refuse_key() returns trigger language plpgsql as $$ begin if new.created_at < coalesce((select max(until) from chain_refuse_until), 'infinity') then raise exception 'chain refuses the deploy record'; end if; return new; end $$");
  await rows(`create trigger chain_refuse_key before update of public_key on workflow_run for each row when (new.created_at > '${new Date().toISOString()}') execute function chain_refuse_key()`);
}

async function refuseUntil(at: Date): Promise<void> {
  await rows(`insert into chain_refuse_until values ('${at.toISOString()}')`);
}

async function acceptKeys(): Promise<void> {
  await rows("drop trigger if exists chain_refuse_key on workflow_run");
  await rows("drop function if exists chain_refuse_key()");
  await rows("drop table if exists chain_refuse_until");
}

const held = once(async function held() {
  const [before, sent, missed] = [(await managers()).length, await wakes(), github.misses.length];
  await holdKeys();
  let keyWhenWoken: string | null;
  try {
    await pushed(UNSTARTED, pullOf(1, sha("held-1")));
    const manager = await until("the listener to wake the manager it deployed", async function woken() {
      const deployed = (await managers()).slice(before);
      return deployed.length === 1 && (await wakes()) > sent ? deployed[0] : undefined;
    });
    keyWhenWoken = await publicKeyOf(manager.id);
    await recordKeys();
    await until("the manager's deploy to be recorded", async () => (await publicKeyOf(manager.id)) ?? undefined);
  } finally {
    await cleanup("record the manager's keys", recordKeys);
    await cleanup("drop the mail hold", dropHold);
  }
  const claim = await settled(UNSTARTED, 1);
  return { keyWhenWoken, claim, deployed: (await managers()).slice(before), writes: github.writesTo(UNSTARTED, 1), misses: github.misses.slice(missed) };
});

test("the listener wakes a manager before its deploy is recorded, and stock delivers the mail once it is", async () => {
  const { keyWhenWoken, claim, deployed, writes, misses } = await held();
  expect(misses).toEqual([]);
  expect(keyWhenWoken).toBeNull();
  expect(deployed).toHaveLength(1);
  expect(claim).toMatchObject({ status: "ended" });
  expect(claim.history.at(-1)).toMatchObject({ runId: deployed[0]!.id });
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
});

const failed = once(async function failed() {
  const [before, missed] = [(await managers()).length, github.misses.length];
  const second = sha("unstarted-3");
  await refuseKeys();
  let claim: Claim;
  let whileFailed: Write[];
  try {
    await pushed(UNSTARTED, pullOf(2, sha("unstarted-2")));
    const first = await until("the listener to deploy a manager", async () => (await managers()).slice(before)[0]);
    await refuseUntil(new Date(first.createdAt.getTime() + 1));
    await until("stock to drop the failed manager's wake mail", () => stack.hub.logs.find((line) => line.includes("Dropping mail to") && line.includes(first.id) && line.includes("deferred-mail TTL expired")), DROPPED_MS);
    whileFailed = [...github.writesTo(UNSTARTED, 2)];
    await pushed(UNSTARTED, pullOf(2, second), "synchronize");
    claim = await settled(UNSTARTED, 2);
  } finally {
    await cleanup("accept keys again", acceptKeys);
  }
  return { second, whileFailed, claim, deployed: (await managers()).slice(before), writes: github.writesTo(UNSTARTED, 2), misses: github.misses.slice(missed) };
});

test("a manager whose deploy fails loses its pull request once stock's mail hold drops its wake, so the next event asks the listener for another, which posts the verdict", async () => {
  const { second, whileFailed, claim, deployed, writes, misses } = await failed();
  expect(misses).toEqual([]);
  expect(whileFailed).toEqual([]);
  expect(deployed).toHaveLength(2);
  expect(claim).toMatchObject({ status: "ended" });
  expect(claim.history.map((pass) => [pass.head, pass.runId])).toEqual([[second, deployed[1]!.id]]);
  expect(isLiveDeployment(deployed[1]!.status)).toBe(false);
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
});

const cancelled = once(async function cancelled() {
  const [before, missed] = [(await managers()).length, github.misses.length];
  const second = sha("cancelled-2");
  await refuseKeys();
  let claim: Claim;
  let first: { id: string; createdAt: Date };
  try {
    await pushed(UNSTARTED, pullOf(3, sha("cancelled-1")));
    first = await until("the listener to deploy a manager", async () => (await managers()).slice(before)[0]);
    await refuseUntil(new Date(first.createdAt.getTime() + 1));
    const { transport, tenantId } = stack.workspace;
    await transport.fetch("DELETE", `/api/tenants/${tenantId}/workflows/runs/${first.id}`);
    await pushed(UNSTARTED, pullOf(3, second), "synchronize");
    claim = await settled(UNSTARTED, 3);
  } finally {
    await cleanup("accept keys again", acceptKeys);
  }
  return { first, second, claim, deployed: (await managers()).slice(before), writes: github.writesTo(UNSTARTED, 3), misses: github.misses.slice(missed) };
});

test("a manager whose start is cancelled stops holding off the next ask, so the next event inside the mail hold asks the listener for another, which posts the verdict", async () => {
  const { first, second, claim, deployed, writes, misses } = await cancelled();
  expect(misses).toEqual([]);
  expect(deployed.map((run) => run.id)).toEqual([first.id, claim.history.at(-1)!.runId]);
  expect(deployed[1]!.createdAt.getTime() - first.createdAt.getTime()).toBeLessThan(MAIL_HOLD_MS);
  expect(claim).toMatchObject({ status: "ended" });
  expect(claim.history.map((pass) => pass.head)).toEqual([second]);
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
});
