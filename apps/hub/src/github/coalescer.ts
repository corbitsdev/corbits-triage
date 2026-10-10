// Holds a pull request's webhook events for a short window and mails them as
// one triage run: the head the latest pull_request event named (else the
// first event's), the latest event for workflows that read one, and every
// event seen. The head is marked
// queued when its first event is accepted, so a window lost to a restart is
// recovered by the reconciler. Every accepted event opens or joins a window,
// even on a head already queued: a queued row does not say whether its run
// has read facts yet. The window map lives in process: the hub runs as one
// replica.
import type { CheckPack, RepoPolicy, TriageEvent } from "@corbits/triage-contracts";
import { mailPayload } from "./bridge.js";
import type { PrMail } from "./normalize.js";
import type { RepoRecord } from "./tenant-config.js";
import type { HeadChecksReader } from "./tenant-open-heads.js";
import { failHead, queueHead, restoreHead, type QueuedHead, type Remembered } from "./triage-queue.js";
import { TriageStateConflictError, type TriageStateStore } from "./triage-state-store.js";

export type CoalesceWindow = { quietMs: number; maxWaitMs: number };

/** Schedules `fire` after `ms`; the returned function cancels it. */
export type SetTimer = (fire: () => Promise<void>, ms: number) => () => void;

export type CoalescedEvent = {
  tenantId: string;
  workflow: string;
  record: RepoRecord;
  policy: RepoPolicy;
  pack: CheckPack;
  mail: PrMail;
  number: number;
  headSha: string;
  event: TriageEvent;
};

export type Accepted = "queued" | "coalesced";

export type CoalescerDeps = {
  store: TriageStateStore;
  sendMail: (tenantId: string, workflow: string, payload: unknown) => Promise<unknown>;
  headChecks: HeadChecksReader;
  window: CoalesceWindow;
  setTimer: SetTimer;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

export type Coalescer = {
  /** Throws when the head could not be marked queued. */
  accept: (input: CoalescedEvent) => Promise<Accepted>;
  /** Cancels every window's timers; their heads stay queued for the reconciler. */
  stop: () => void;
};

type Open = {
  latest: CoalescedEvent;
  head: QueuedHead;
  remembered: Remembered;
  events: TriageEvent[];
  cancelQuiet: () => void;
  cancelDeadline: () => void;
};

async function settled(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch {
    // The caller of `work` handles its failure; the chain only waits for it.
  }
}

export function createCoalescer(deps: CoalescerDeps): Coalescer {
  const windows = new Map<string, Open>();
  /** The last accept or flush of each pull request, so they never interleave. */
  const tails = new Map<string, Promise<void>>();

  function keyOf({ tenantId, record, number }: CoalescedEvent): string {
    return `${tenantId}\n${record.name}\n${number}`;
  }

  function headOf({ tenantId, record, number, headSha }: CoalescedEvent): QueuedHead {
    return { tenantId, repo: record.name, number, headSha };
  }

  async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = tails.get(key);
    const current = runAfter(previous, work);
    const tail = settled(current);
    tails.set(key, tail);
    try {
      return await current;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  }

  async function runAfter<T>(previous: Promise<void> | undefined, work: () => Promise<T>): Promise<T> {
    await previous;
    return work();
  }

  function timer(key: string, ms: number): () => void {
    return deps.setTimer(function onWindowEnd() {
      return flushLogged(key);
    }, ms);
  }

  async function checksPending(open: Open): Promise<boolean> {
    const { tenantId, record } = open.latest;
    try {
      const checks = await deps.headChecks(tenantId, record, open.head.headSha);
      return checks.some((check) => check.status !== "completed");
    } catch (err) {
      deps.log({ level: "warn", msg: "coalesced_checks_unread", tenantId, repo: record.name, pr: open.head.number, headSha: open.head.headSha, error: String(err) });
      return false;
    }
  }

  async function flush(key: string): Promise<void> {
    const open = windows.get(key);
    if (!open) return;
    windows.delete(key);
    open.cancelQuiet();
    open.cancelDeadline();
    const { latest, head, events } = open;
    const entry = { tenantId: head.tenantId, repo: head.repo, pr: head.number, headSha: head.headSha, events };
    // CI still running on the head is re-triaged once by its last completed check run.
    if (events.every((event) => event === "checks") && await checksPending(open)) {
      await restoreHead(deps.store, head, open.remembered);
      deps.log({ level: "info", msg: "coalesced_dropped", ...entry, reason: "checks_pending" });
      return;
    }
    try {
      await deps.sendMail(head.tenantId, latest.workflow, mailPayload(head.repo, latest.policy, latest.pack, { ...latest.mail, headSha: head.headSha, events }));
    } catch (err) {
      deps.log({ level: "error", msg: "forward_failed", ...entry, error: String(err) });
      await failHead(deps.store, head, `delivery failed: ${String(err)}`, deps.now());
      return;
    }
    deps.log({ level: "info", msg: "forwarded", ...entry, workflow: latest.workflow });
  }

  async function flushLogged(key: string): Promise<void> {
    try {
      await serialized(key, function flushWindow() {
        return flush(key);
      });
    } catch (err) {
      deps.log({ level: "error", msg: "coalesced_flush_failed", key, error: String(err) });
    }
  }

  /** Marks the head queued whatever its row says, so its window's mail is the one that triages it. */
  async function queue(head: QueuedHead): Promise<Remembered> {
    const queued = await queueHead(deps.store, head, deps.now(), function never() {
      return false;
    });
    if (queued.status !== "queued") throw new TriageStateConflictError(head.repo);
    return queued.remembered;
  }

  async function join(key: string, open: Open, input: CoalescedEvent): Promise<Accepted> {
    // Check runs and comments may name a superseded commit; only the pull request itself says where its head is.
    if (input.mail.event === "pull_request" && input.headSha !== open.head.headSha) {
      const head = headOf(input);
      open.remembered = await queue(head);
      open.head = head;
    }
    open.latest = input;
    if (!open.events.includes(input.event)) open.events.push(input.event);
    open.cancelQuiet();
    open.cancelQuiet = timer(key, deps.window.quietMs);
    return "coalesced";
  }

  async function acceptNow(key: string, input: CoalescedEvent): Promise<Accepted> {
    const open = windows.get(key);
    if (open) return join(key, open, input);
    const head = headOf(input);
    windows.set(key, {
      latest: input,
      head,
      remembered: await queue(head),
      events: [input.event],
      cancelQuiet: timer(key, deps.window.quietMs),
      cancelDeadline: timer(key, deps.window.maxWaitMs),
    });
    return "queued";
  }

  return {
    accept(input) {
      const key = keyOf(input);
      return serialized(key, function acceptEvent() {
        return acceptNow(key, input);
      });
    },
    stop() {
      for (const open of windows.values()) {
        open.cancelQuiet();
        open.cancelDeadline();
      }
      windows.clear();
    },
  };
}
