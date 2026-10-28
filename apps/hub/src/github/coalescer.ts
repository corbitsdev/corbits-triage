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
// has read facts yet. Every window is mailed when it closes, CI running or
// not: the pull request's manager waits for CI itself, and the check events
// that finish it reach it as one more window. A window of check events alone
// reads whether its pull request is still open and ready once at its flush,
// since their payloads do not say. The window map lives in process: the hub
// runs as one replica.
import type { ActionKind, CheckPack, PolicySource, PolicyWorkflow, PrTriageRow, RepoPolicy, TriageEvent } from "@corbits/triage-contracts";
import { mailPayload, unreadablePayload, type PolicyUnreadable } from "./bridge.js";
import type { TriageJob } from "./triage-queue.js";
import { GithubRateLimited } from "./github-usage.js";
import type { PrMail } from "./normalize.js";
import { triageStateKey, type RepoRecord } from "./tenant-config.js";
import type { OpenHeadReader } from "./tenant-open-heads.js";
import { deliveryFailure, failHead, queueHead, restoreHead, type QueuedHead, type Remembered } from "./triage-queue.js";
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
  openHeadFor: (tenantId: string) => Promise<OpenHeadReader | undefined>;
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
    await restoreHead(deps.store, open.head, open.remembered);
    deps.log({ level: "info", msg: "coalesced_dropped", ...entry, reason });
  }

  async function flush(key: string): Promise<void> {
    const open = windows.get(key);
    if (!open) return;
    windows.delete(key);
    open.cancelQuiet();
    open.cancelDeadline();
    const { latest, head, events } = open;
    const entry = { tenantId: head.tenantId, repo: latest.record.name, pr: head.number, headSha: head.headSha, events };
    let unready: string | undefined;
    try {
      unready = open.draftUnread ? await notReady(open) : undefined;
    } catch (err) {
      if (err instanceof GithubRateLimited) return drop(open, entry, "github_rate_limited");
      deps.log({ level: "error", msg: "head_lookup_failed", ...entry, error: String(err) });
      // Failed, the head stays due for the reconciler.
      await failHead(deps.store, head, `head lookup failed: ${String(err)}`, deps.now());
      return;
    }
    if (unready !== undefined) return drop(open, entry, unready);
    try {
      const extra = { ...latest.mail, headSha: head.headSha, events };
      const payload = "pack" in latest ? mailPayload(latest.record, latest.policy, latest, extra) : unreadablePayload(latest.record, latest.policy, latest, extra);
      await deps.sendMail({ ...head, record: latest.record, payload });
    } catch (err) {
      if (err instanceof GithubRateLimited) return drop(open, entry, "github_rate_limited");
      deps.log({ level: "error", msg: "forward_failed", ...entry, error: String(err) });
      await failHead(deps.store, head, deliveryFailure(err), deps.now());
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

  /** Marks the head queued, so its window's mail is the one that triages it. */
  async function queue(head: QueuedHead): Promise<Remembered> {
    const outcome = await queueHead(deps.store, head, deps.now(), never);
    if (outcome.status !== "queued") throw new TriageStateConflictError(head.repo);
    return outcome.remembered;
  }

  async function join(key: string, open: Open, input: CoalescedEvent, startsBurst: boolean): Promise<Accepted> {
    if (startsTriage(input) && input.headSha !== open.head.headSha) {
      open.head = headOf(input, input.headSha);
      open.remembered = await queue(open.head);
    }
    open.latest = input;
    open.draftUnread &&= input.draftUnread === true;
    for (const event of eventsOf(input, open.remembered.rows)) if (!open.events.includes(event)) open.events.push(event);
    if (open.closesOnBurst) return "coalesced";
    open.closesOnBurst = startsBurst;
    open.cancelQuiet();
    open.cancelQuiet = timer(key, startsBurst ? deps.window.burstMs : deps.window.quietMs);
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
    const remembered = await queue(head);
    windows.set(key, {
      latest: input,
      head,
      remembered,
      events: eventsOf(input, remembered.rows),
      draftUnread: input.draftUnread === true,
      closesOnBurst: startsBurst,
      cancelQuiet: timer(key, startsBurst ? deps.window.burstMs : deps.window.quietMs),
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
