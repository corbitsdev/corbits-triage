// Holds a pull request's webhook events for a short window and mails them as
// one triage run: the head the latest new commit or opening of the pull
// request named (else the first event's), the latest event for workflows that
// read one, and every event seen. A new commit, or a pull request opened,
// reopened or marked ready, closes its window after a short burst, as does an
// approval or a change request, so its triage starts at once with the events
// GitHub sends alongside it. Comments, other chatter and check events wait out
// the quiet period. The head is marked
// queued when its first event is accepted, so a window lost to a restart is
// recovered by the reconciler. Every accepted event opens or joins a window,
// even on a head already queued: a queued row does not say whether its run
// has read facts yet. When the policy reads CI and CI on the head is still
// running, the head waits instead, holding its events, and the window that
// sees CI finish, or the reconciler, mails it; a new commit first takes over
// the events an earlier head held. Check events on a waiting head
// leave its row as it is until CI is read done, and a completed check suite
// closes their window on the burst. The window map lives in
// process: the hub runs as one replica.
import { dependsOnCi, marksWaiting, type ActionKind, type CheckPack, type PolicySource, type PolicyWorkflow, type PrTriageRow, type RepoPolicy, type TriageEvent } from "@corbits/triage-contracts";
import { checkPending, summarizeChecks, type CheckRun } from "@corbits/github-reads";
import { mailPayload, waitingPayload } from "./bridge.js";
import type { TriageJob } from "./coordinator.js";
import type { PrMail } from "./normalize.js";
import { sourceOf, triageStateKey, type RepoRecord } from "./tenant-config.js";
import type { HeadChecksReader } from "./tenant-open-heads.js";
import { inFlight, waitedOut, waitsForCi, type ReconcilePolicy } from "./reconcile-plan.js";
import { failHead, queueHead, restoreHead, waitHead, type QueuedHead, type Remembered } from "./triage-queue.js";
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
  policyWorkflow?: PolicyWorkflow;
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
  ciWait: Pick<ReconcilePolicy, "ciWaitMaxMs" | "ciStartGraceMs">;
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
  prior: PrTriageRow | undefined;
  /** Undefined while the window holds only check events on a head waiting for CI, whose row stays as it is. */
  remembered: Remembered | undefined;
  events: TriageEvent[];
  /** Holds a head-moving event, an approval or a change request, so it closes on the burst and later events do not extend it. */
  closesOnBurst: boolean;
  cancelQuiet: () => void;
  cancelDeadline: () => void;
};

const STARTING_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

function startsTriage({ mail }: CoalescedEvent): boolean {
  return mail.event === "pull_request" && mail.action !== null && STARTING_ACTIONS.has(mail.action);
}

function endsConversation({ event }: CoalescedEvent): boolean {
  return event === "approved" || event === "changes-requested";
}

function never(): boolean {
  return false;
}

function movedOn(prior: PrTriageRow | undefined): boolean {
  return prior?.status !== "waiting";
}

function heldForCi({ event }: CoalescedEvent, prior: PrTriageRow | undefined): boolean {
  return event === "checks" && prior?.status === "waiting";
}

function heldEvents(prior: PrTriageRow | undefined): TriageEvent[] {
  return prior?.status === "waiting" ? prior.events ?? [] : [];
}

/** A check suite completes once per CI app, so its flush, which reads CI, can release the head soon after its last check. */
function mayReleaseHold(input: CoalescedEvent, prior: PrTriageRow | undefined): boolean {
  return input.mail.event === "check_suite" && heldForCi(input, prior);
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

  /** Undefined when they could not be read, so the head is triaged rather than held. */
  async function checksOf(open: Open): Promise<CheckRun[] | undefined> {
    const { tenantId, record } = open.latest;
    try {
      return await deps.headChecks(tenantId, record, open.head.headSha);
    } catch (err) {
      deps.log({ level: "warn", msg: "coalesced_checks_unread", tenantId, repo: record.name, pr: open.head.number, headSha: open.head.headSha, error: String(err) });
      return undefined;
    }
  }

  async function drop(open: Open, entry: Record<string, unknown>, reason: string): Promise<void> {
    if (open.remembered) await restoreHead(deps.store, open.head, open.remembered);
    deps.log({ level: "info", msg: "coalesced_dropped", ...entry, reason });
  }

  /** The waiting marker is only shown, so a mail that did not go out is logged and the head still waits. */
  async function markWaiting({ latest, head }: Open, noCi: boolean): Promise<void> {
    if (!marksWaiting(sourceOf(latest.record), latest.automatic)) return;
    try {
      await deps.sendMail({ ...head, workflow: latest.workflow, source: "event", payload: waitingPayload(latest.record, latest.policy, latest, head, noCi) });
    } catch (err) {
      deps.log({ level: "warn", msg: "waiting_mail_failed", tenantId: head.tenantId, repo: latest.record.name, pr: head.number, headSha: head.headSha, error: String(err) });
    }
  }

  async function flush(key: string): Promise<void> {
    const open = windows.get(key);
    if (!open) return;
    windows.delete(key);
    open.cancelQuiet();
    open.cancelDeadline();
    const { latest, head, prior } = open;
    const entry = { tenantId: head.tenantId, repo: latest.record.name, pr: head.number, headSha: head.headSha, events: open.events };
    const checksOnly = open.events.every((event) => event === "checks");
    const readsCi = dependsOnCi(latest.pack);
    // A head the reconciler released from waiting after its CI finished already has its one run.
    if (readsCi && checksOnly && prior !== undefined && inFlight(prior) && prior.events !== undefined) return drop(open, entry, "released");
    const checks = checksOnly || readsCi ? await checksOf(open) : undefined;
    const ci = checks && summarizeChecks(checks);
    // CI still running on the head is re-triaged once by its last completed check run; a head waiting for CI is released by its first failed check.
    const pending = prior?.status === "waiting" ? ci === "pending" : checks?.some(checkPending) === true;
    if (checksOnly && pending) return drop(open, entry, "checks_pending");
    // Undefined when the reconciler moved the head on since its window opened.
    const { remembered } = open.remembered ? open : await queue(head, movedOn, false);
    if (remembered === undefined) return drop(open, entry, "released");
    const events = [...new Set([...heldEvents(prior), ...open.events])];
    const firstSeenAt = remembered.rows.find((row) => row.number === head.number && row.headSha === head.headSha)!.firstSeenAt;
    if (readsCi && waitsForCi(ci, firstSeenAt, deps.now(), deps.ciWait)) {
      await waitHead(deps.store, head, events, deps.now());
      deps.log({ level: "info", msg: "triage_waiting_ci", ...entry, events, ci });
      if (prior?.status !== "waiting") await markWaiting(open, ci === "none");
      return;
    }
    try {
      const noWait = waitedOut(firstSeenAt, deps.now(), deps.ciWait);
      const payload = mailPayload(latest.record, latest.policy, latest, { ...latest.mail, headSha: head.headSha, events, ...(noWait && { noWait }) });
      await deps.sendMail({ ...head, workflow: latest.workflow, source: "event", record: latest.record, payload });
    } catch (err) {
      deps.log({ level: "error", msg: "forward_failed", ...entry, error: String(err) });
      await failHead(deps.store, head, `delivery failed: ${String(err)}`, deps.now());
      return;
    }
    deps.log({ level: "info", msg: "forwarded", ...entry, events, workflow: latest.workflow });
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

  /** Marks the head queued unless `keep` holds for its row, so its window's mail is the one that triages it; a new commit takes over the events heads it replaced held. */
  async function queue(head: QueuedHead, keep: (prior: PrTriageRow | undefined) => boolean, supersedes: boolean): Promise<Pick<Open, "prior" | "remembered"> & { held: TriageEvent[] }> {
    const outcome = await queueHead(deps.store, head, deps.now(), keep, supersedes);
    if (outcome.status === "conflict") throw new TriageStateConflictError(head.repo);
    if (outcome.status === "kept") return { prior: outcome.prior, remembered: undefined, held: [] };
    return { prior: outcome.remembered.prior, remembered: outcome.remembered, held: outcome.held };
  }

  async function join(key: string, open: Open, input: CoalescedEvent, startsBurst: boolean): Promise<Accepted> {
    const moved = startsTriage(input) && input.headSha !== open.head.headSha;
    if (moved || (!open.remembered && input.event !== "checks")) {
      const head = moved ? headOf(input, input.headSha) : open.head;
      // The replaced head's row was queued when this window opened, so the events it held for CI are carried from the window.
      const held = moved ? heldEvents(open.prior) : [];
      const queued = await queue(head, never, moved);
      open.prior = queued.prior;
      open.remembered = queued.remembered;
      open.head = head;
      open.events = [...new Set([...held, ...queued.held, ...open.events])];
    }
    open.latest = input;
    for (const event of eventsOf(input, open.remembered?.rows ?? [])) if (!open.events.includes(event)) open.events.push(event);
    if (open.closesOnBurst) return "coalesced";
    const closesOnBurst = startsBurst || mayReleaseHold(input, open.prior);
    open.closesOnBurst = closesOnBurst;
    open.cancelQuiet();
    open.cancelQuiet = timer(key, closesOnBurst ? deps.window.burstMs : deps.window.quietMs);
    return "coalesced";
  }

  async function acceptNow(key: string, input: CoalescedEvent): Promise<Accepted> {
    const starting = startsTriage(input);
    const startsBurst = starting || endsConversation(input);
    // Other events, even other pull_request ones, may name a superseded commit; only a new commit or an opening says where the head is.
    if (starting) newest.set(key, input.headSha);
    const open = windows.get(key);
    if (open) return join(key, open, input, startsBurst);
    const head = headOf(input, newest.get(key) ?? input.headSha);
    // A check event leaves a head waiting for CI as it is, so a flush that finds CI still running writes nothing.
    const { prior, remembered, held } = await queue(head, function waitingOnChecks(row) {
      return heldForCi(input, row);
    }, starting);
    const closesOnBurst = startsBurst || mayReleaseHold(input, prior);
    windows.set(key, {
      latest: input,
      head,
      prior,
      remembered,
      events: [...new Set([...held, ...eventsOf(input, remembered?.rows ?? [])])],
      closesOnBurst,
      cancelQuiet: timer(key, closesOnBurst ? deps.window.burstMs : deps.window.quietMs),
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
