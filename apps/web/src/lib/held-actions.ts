import { errorText } from "./error-text.ts";

/** How long an action waits for Undo before it is sent, and how long its result stays on screen. */
export const HOLD_MS = 6_000;

/**
 * What a send reports. `complete` is false when only part of it reached GitHub; `kept` is false when
 * what did not arrive still needs the user, so the pull request comes back as after a failed send.
 */
export type Outcome = { message: string; complete: boolean; kept: boolean };

/**
 * One action waiting to be sent. `send` is told whether the page is being left, so its writes can outlive it.
 * `restore` puts back what the screen already changed; `undo` does that for Undo, and `failText` says why a send failed.
 */
export type HeldAction = {
  pending: string;
  send: (leaving: boolean) => Promise<Outcome>;
  undo: () => void;
  restore: () => void;
  failText: (error: string) => string;
};

/** `held` can still be undone; `sending` is past Undo and waits on GitHub. */
type Phase = "held" | "sending";

type Entry = { id: number; action: HeldAction; phase: Phase; timer: number | null; delivery: Promise<void> | null };

type Result = "sent" | "partial" | "failed";

/** The toast for the held action, and the last result to announce; `partial` and `failed` need the user to look. */
export type Notices = {
  held: { id: number; message: string } | null;
  outcome: { id: number; message: string; result: Result } | null;
};

export type Timers = { set: (run: () => void, ms: number) => number; clear: (id: number) => void };

export type HoldQueue = {
  hold: (action: HeldAction) => void;
  undo: () => boolean;
  flush: () => Promise<void>;
  notices: () => Notices;
  subscribe: (listener: () => void) => () => void;
};

/**
 * Holds one action at a time for `holdMs` before sending it. Holding another sends the previous one
 * right away, since its Undo is gone; `flush` sends what is held as the page is left and waits for every send.
 */
export function createHoldQueue(timers: Timers, holdMs: number): HoldQueue {
  const entries = new Set<Entry>();
  const listeners = new Set<() => void>();
  let lastId = 0;
  let notices: Notices = { held: null, outcome: null };
  let outcomeTimer: number | null = null;

  function heldEntry(): Entry | null {
    for (const entry of entries) if (entry.phase === "held") return entry;
    return null;
  }

  function publish(outcome: Notices["outcome"]) {
    const held = heldEntry();
    const heldNotice = held === null ? null : notices.held?.id === held.id ? notices.held : { id: held.id, message: held.action.pending };
    notices = { held: heldNotice, outcome };
    for (const listener of listeners) listener();
  }

  function announce(message: string, result: Result) {
    if (outcomeTimer !== null) timers.clear(outcomeTimer);
    const outcome = { id: ++lastId, message, result };
    outcomeTimer = timers.set(function clearOutcome() {
      outcomeTimer = null;
      if (notices.outcome?.id === outcome.id) publish(null);
    }, holdMs);
    publish(outcome);
  }

  async function deliver(entry: Entry, leaving: boolean): Promise<void> {
    try {
      const outcome = await entry.action.send(leaving);
      if (!outcome.kept) entry.action.restore();
      announce(outcome.message, outcome.complete ? "sent" : "partial");
    } catch (cause) {
      entry.action.restore();
      announce(entry.action.failText(errorText(cause)), "failed");
    } finally {
      entries.delete(entry);
      publish(notices.outcome);
    }
  }

  function send(entry: Entry, leaving: boolean) {
    if (entry.timer !== null) timers.clear(entry.timer);
    entry.timer = null;
    entry.phase = "sending";
    entry.delivery = deliver(entry, leaving);
    publish(notices.outcome);
  }

  function hold(action: HeldAction) {
    const previous = heldEntry();
    if (previous !== null) send(previous, false);
    const entry: Entry = { id: ++lastId, action, phase: "held", timer: null, delivery: null };
    entry.timer = timers.set(function sendWhenHoldEnds() {
      send(entry, false);
    }, holdMs);
    entries.add(entry);
    publish(notices.outcome);
  }

  function undo(): boolean {
    const entry = heldEntry();
    if (entry === null) return false;
    if (entry.timer !== null) timers.clear(entry.timer);
    entries.delete(entry);
    entry.action.undo();
    publish(notices.outcome);
    return true;
  }

  async function flush(): Promise<void> {
    const held = heldEntry();
    if (held !== null) send(held, true);
    await Promise.all([...entries].map((entry) => entry.delivery));
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return function unsubscribe() {
      listeners.delete(listener);
    };
  }

  return { hold, undo, flush, notices: () => notices, subscribe };
}

export const browserTimers: Timers = {
  set: function setBrowserTimer(run, ms) {
    return window.setTimeout(run, ms);
  },
  clear: function clearBrowserTimer(id) {
    window.clearTimeout(id);
  },
};
