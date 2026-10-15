// Holds a pull request's webhook events for a short window and mails them as
// one triage run: the head the latest new commit or opening of the pull
// request named (else the first event's), the latest event for workflows that read one, and every
// event seen. A new commit or a pull request opened, reopened or marked ready
// closes its window after a short burst instead, so its triage starts at once
// with the events GitHub sends alongside it. The head is marked
// queued when its first event is accepted, so a window lost to a restart is
// recovered by the reconciler. Every accepted event opens or joins a window,
// even on a head already queued: a queued row does not say whether its run
// has read facts yet. The window map lives in process: the hub runs as one
// replica.
import type { ActionKind, CheckPack, PolicySource, PrTriageRow, RepoPolicy, TriageEvent } from "@corbits/triage-contracts";
import { mailPayload } from "./bridge.js";
import type { TriageJob } from "./coordinator.js";
import type { PrMail } from "./normalize.js";
import { triageStateKey, type RepoRecord } from "./tenant-config.js";
import type { HeadChecksReader } from "./tenant-open-heads.js";
import { failHead, queueHead, restoreHead, type QueuedHead, type Remembered } from "./triage-queue.js";
import { TriageStateConflictError, type TriageStateStore } from "./triage-state-store.js";

export type CoalesceWindow = { quietMs: number; maxWaitMs: number; burstMs: number };

type SetTimer = (fire: () => Promise<void>, ms: number) => () => void;

export type CoalescedEvent = {
  tenantId: string;
  workflow: string;
  record: RepoRecord;
  policy: RepoPolicy;
  pack: CheckPack;
  automatic: ActionKind[];
  /** Read with `pack` when the event was accepted, shared policy included, so the mail names the versions it carries. */
  source: PolicySource;
  mail: PrMail;
  number: number;
  headSha: string;
  event: TriageEvent;
};

export type Accepted = "queued" | "coalesced";

export type CoalescerDeps = {
  store: TriageStateStore;
  sendMail: (job: TriageJob) => Promise<unknown>;
  headChecks: HeadChecksReader;
  window: CoalesceWindow;
  setTimer: SetTimer;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

export type Coalescer = {
  accept: (input: CoalescedEvent) => Promise<Accepted>;
  /** Cancels every window's timers; their heads stay queued for the reconciler. */
  stop: () => void;
};

type Open = {
  latest: CoalescedEvent;
  head: QueuedHead;
  remembered: Remembered;
  events: TriageEvent[];
  /** Holds a new commit or a newly opened pull request, so it closes on the burst and later events do not extend it. */
  starting: boolean;
  cancelQuiet: () => void;
  cancelDeadline: () => void;
};

const STARTING_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

function startsTriage({ mail }: CoalescedEvent): boolean {
  return mail.event === "pull_request" && mail.action !== null && STARTING_ACTIONS.has(mail.action);
}

/** A pull request marked ready before any run triaged it was opened as a draft, so its opening wakes now too. */
function eventsOf(input: CoalescedEvent, rows: readonly PrTriageRow[]): TriageEvent[] {
  const untriaged = input.event === "ready" && !rows.some((row) => row.number === input.number && row.runId !== undefined);
  return untriaged ? ["ready", "opened"] : [input.event];
}

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
  /** The head each pull request's latest new commit or opening named, kept past its window so a late event cannot move it back. */
  const newest = new Map<string, string>();

  function keyOf({ tenantId, record, number }: CoalescedEvent): string {
    return `${tenantId}\n${triageStateKey(record)}\n${number}`;
  }

  function headOf({ tenantId, record, number }: CoalescedEvent, headSha: string): QueuedHead {
    return { tenantId, repo: triageStateKey(record), number, headSha };
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
    const entry = { tenantId: head.tenantId, repo: latest.record.name, pr: head.number, headSha: head.headSha, events };
    // CI still running on the head is re-triaged once by its last completed check run.
    if (events.every((event) => event === "checks") && await checksPending(open)) {
      await restoreHead(deps.store, head, open.remembered);
      deps.log({ level: "info", msg: "coalesced_dropped", ...entry, reason: "checks_pending" });
      return;
    }
    try {
      const payload = mailPayload(latest.record, latest.policy, latest, { ...latest.mail, headSha: head.headSha, events });
      await deps.sendMail({ ...head, workflow: latest.workflow, source: "event", payload });
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
    if (startsTriage(input) && input.headSha !== open.head.headSha) {
      const head = headOf(input, input.headSha);
      open.remembered = await queue(head);
      open.head = head;
    }
    open.latest = input;
    for (const event of eventsOf(input, open.remembered.rows)) if (!open.events.includes(event)) open.events.push(event);
    if (open.starting) return "coalesced";
    open.starting = startsTriage(input);
    open.cancelQuiet();
    open.cancelQuiet = timer(key, open.starting ? deps.window.burstMs : deps.window.quietMs);
    return "coalesced";
  }

  async function acceptNow(key: string, input: CoalescedEvent): Promise<Accepted> {
    const starting = startsTriage(input);
    // Other events, even other pull_request ones, may name a superseded commit; only a new commit or an opening says where the head is.
    if (starting) newest.set(key, input.headSha);
    const open = windows.get(key);
    if (open) return join(key, open, input);
    const head = headOf(input, newest.get(key) ?? input.headSha);
    const remembered = await queue(head);
    windows.set(key, {
      latest: input,
      head,
      remembered,
      events: eventsOf(input, remembered.rows),
      starting,
      cancelQuiet: timer(key, starting ? deps.window.burstMs : deps.window.quietMs),
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
