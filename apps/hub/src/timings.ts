import { DEFAULT_TIMINGS, type Timings } from "@corbits/triage-contracts";

/**
 * How long stock holds mail to a run whose deploy is not recorded yet, and mail across a sidecar disconnect, unless
 * `HUB_MAIL_HOLD_TTL_MS` sets another. Above stock's five minutes so routed triage mail survives a long pack receive.
 */
export const DEFAULT_MAIL_HOLD_MS = 15 * 60_000;

/**
 * The hub's waits: Triage's, and how long stock holds mail to a just-deployed run before dropping it. A manager whose
 * wake mail is still held may yet start, so the hub's start grace for a manager is that hold.
 */
export type HubTimings = Timings & { mailHoldMs: number };

let current: HubTimings = { ...DEFAULT_TIMINGS, mailHoldMs: DEFAULT_MAIL_HOLD_MS };

/** Sets the waits the hub runs on, which boot reads from its environment once. */
export function setTimings(timings: HubTimings): void {
  current = timings;
}

/** The hub's waits: those boot set, else the defaults. */
export function timings(): HubTimings {
  return current;
}
