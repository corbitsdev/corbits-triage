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
// has read facts yet. When the policy reads CI and a window that is not only
// check events finds CI still running, the head waits instead, holding its
// events, and the window that sees CI finish, or the reconciler, mails it; a
// new commit first takes over the events an earlier head held. A window of
// check events alone is mailed either way, pending or green: check webhooks
// are not replayed, and the manager, not this process, holds a still-pending
// head. Check events on a waiting head leave its row as it is until the flush
// mails them. A completed check suite closes their window on the burst. A
// window of check events alone reads whether its pull request is still open
// and ready once at its flush, since their payloads do not say. The window
// map lives in process: the hub runs as one replica.
import { dependsOnCi, marksWaiting, type ActionKind, type CheckPack, type PolicySource, type PolicyWorkflow, type PrTriageRow, type RepoPolicy, type TriageEvent } from "@corbits/triage-contracts";
import { summarizeChecks, type CheckRun } from "@corbits/github-reads";
import { mailPayload, unreadablePayload, waitingPayload, type PolicyUnreadable } from "./bridge.js";
import type { TriageJob } from "./triage-queue.js";
import { GithubRateLimited } from "./github-usage.js";
import type { PrMail } from "./normalize.js";
import { sourceOf, triageStateKey, type RepoRecord } from "./tenant-config.js";
import type { HeadChecksReader, OpenHeadReader } from "./tenant-open-heads.js";
import { inFlight, waitedOut, waitsForCi, type ReconcilePolicy } from "./reconcile-plan.js";
import { deliveryFailure, failHead, queueHead, restoreHead, waitHead, type QueuedHead, type Remembered } from "./triage-queue.js";
import { TriageStateConflictError, type TriageStateStore } from "./triage-state-store.js";
import { createKeyedSerial } from "../keyed-serial.js";

export type CoalesceWindow = { quietMs: number; maxWaitMs: number; burstMs: number };

type SetTimer = (fire: () => Promise<void>, ms: number) => () => void;

type ReadPolicy = {
  pack: CheckPack;
  automatic: ActionKind[];
  /** Read with `pack` when the event was accepted, the policy file it extends included, so the mail names the versions it carries. */
  source: PolicySource;
  policyWorkflow?: PolicyWorkflow;
  pauseLabel?: string;
};

export type CoalescedEvent = (ReadPolicy | PolicyUnreadable) & {
  tenantId: string;
  workflow: string;
  record: RepoRecord;
  policy: RepoPolicy;
  mail: PrMail;
  number: number;
  headSha: string;
  event: TriageEvent;
  /** The payload did not say whether the pull request is a draft or still open, as on a check event. */
  draftUnread?: true;
};

export type Accepted = "queued" | "coalesced";

export type CoalescerDeps = {
  store: TriageStateStore;
  sendMail: (job: TriageJob) => Promise<unknown>;
  headChecks: HeadChecksReader;
  openHeadFor: (tenantId: string) => Promise<OpenHeadReader | undefined>;
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
  /** Every event in the window left unread whether the pull request is open and ready. */
  draftUnread: boolean;
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

export function createCoalescer(deps: CoalescerDeps): Coalescer {
  const windows = new Map<string, Open>();
  /** Each pull request's accepts and flushes, so they never interleave. */
  const serialized = createKeyedSerial();
  /** The head each pull request's latest new commit or opening named, kept past its window so a late event cannot move it back. */
  const newest = new Map<string, string>();

  function keyOf({ tenantId, record, number }: CoalescedEvent): string {
    return `${tenantId}\n${triageStateKey(record)}\n${number}`;
  }

  function headOf({ tenantId, record, number }: CoalescedEvent, headSha: string): QueuedHead {
    return { tenantId, repo: triageStateKey(record), number, headSha };
  }

  function timer(key: string, ms: number): () => void {
    return deps.setTimer(function onWindowEnd() {
      return flushLogged(key);
    }, ms);
  }

  /** Undefined when they could not be read, so the head is triaged rather than held; a rate limit is thrown, so the head waits for the reconciler. */
  async function checksOf(open: Open): Promise<CheckRun[] | undefined> {
    const { tenantId, record } = open.latest;
    try {
      return await deps.headChecks(tenantId, record, open.head.headSha);
    } catch (err) {
      if (err instanceof GithubRateLimited) throw err;
      deps.log({ level: "warn", msg: "coalesced_checks_unread", tenantId, repo: record.name, pr: open.head.number, headSha: open.head.headSha, error: String(err) });
      return undefined;
    }
  }

  /** Why the window's pull request is not triaged: a draft, no longer open, or moved past the window's head. */
  async function notReady({ latest, head }: Open): Promise<string | undefined> {
    const read = await deps.openHeadFor(head.tenantId);
    if (!read) throw new Error("no active github credential");
    const pr = await read(latest.record, head.number);
    if (pr === undefined) return "not_open";
    if (pr.headSha !== head.headSha) return "superseded";
    return pr.draft ? "draft" : undefined;
  }

  async function drop(open: Open, entry: Record<string, unknown>, reason: string): Promise<void> {
    if (open.remembered) await restoreHead(deps.store, open.head, open.remembered);
    deps.log({ level: "info", msg: "coalesced_dropped", ...entry, reason });
  }

  /** The waiting marker is only shown, so a mail that did not go out is logged and the head still waits. */
  async function markWaiting({ latest, head }: Open, noCi: boolean): Promise<void> {
    if (!("pack" in latest) || !marksWaiting(sourceOf(latest.record), latest.automatic)) return;
    try {
      await deps.sendMail({ ...head, payload: waitingPayload(latest.record, latest.policy, latest, head, noCi) });
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
    const readsCi = "pack" in latest && dependsOnCi(latest.pack);
    // A head the reconciler released from waiting after its CI finished already has its one run.
    if (readsCi && checksOnly && prior !== undefined && inFlight(prior) && prior.events !== undefined) return drop(open, entry, "released");
    let unready: string | undefined;
    try {
      unready = open.draftUnread ? await notReady(open) : undefined;
    } catch (err) {
      if (err instanceof GithubRateLimited) return drop(open, entry, "github_rate_limited");
      deps.log({ level: "error", msg: "head_lookup_failed", ...entry, error: String(err) });
      // Failed, the head stays due for the reconciler, so a verdict made while CI still ran is not left standing.
      if (open.remembered) await failHead(deps.store, head, `head lookup failed: ${String(err)}`, deps.now());
      return;
    }
    if (unready !== undefined) return drop(open, entry, unready);
    let checks: CheckRun[] | undefined;
    try {
      checks = checksOnly || readsCi ? await checksOf(open) : undefined;
    } catch (err) {
      if (err instanceof GithubRateLimited) return drop(open, entry, "github_rate_limited");
      throw err;
    }
    const ci = checks && summarizeChecks(checks);
    // Undefined when the reconciler moved the head on since its window opened.
    const { remembered } = open.remembered ? open : await queue(head, movedOn, false);
    if (remembered === undefined) return drop(open, entry, "released");
    const events = [...new Set([...heldEvents(prior), ...open.events])];
    const firstSeenAt = remembered.rows.find((row) => row.number === head.number && row.headSha === head.headSha)!.firstSeenAt;
    // Check events are mailed even while CI is pending. The manager refuses the approval, and a verdict that waited
    // records heldForCi so the reconciler queues the head once CI is green. Other events still wait out CI here,
    // keeping the time the head was first seen: the 60-minute give-up is not restarted.
    if (!checksOnly && readsCi && waitsForCi(ci, firstSeenAt, deps.now(), deps.ciWait)) {
      await waitHead(deps.store, head, events, deps.now());
      deps.log({ level: "info", msg: "triage_waiting_ci", ...entry, events, ci });
      if (prior?.status !== "waiting") await markWaiting(open, ci === "none");
      return;
    }
    try {
      const noWait = waitedOut(firstSeenAt, deps.now(), deps.ciWait);
      const extra = { ...latest.mail, headSha: head.headSha, events, ...(noWait && { noWait }) };
      const payload = "pack" in latest ? mailPayload(latest.record, latest.policy, latest, extra) : unreadablePayload(latest.record, latest.policy, latest, extra);
      await deps.sendMail({ ...head, record: latest.record, payload });
    } catch (err) {
      if (err instanceof GithubRateLimited) return drop({ ...open, remembered }, entry, "github_rate_limited");
      deps.log({ level: "error", msg: "forward_failed", ...entry, error: String(err) });
      await failHead(deps.store, head, deliveryFailure(err), deps.now());
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
    open.draftUnread &&= input.draftUnread === true;
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
      draftUnread: input.draftUnread === true,
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
