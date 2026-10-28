import { DEFAULT_TIMINGS, type Timings } from "@corbits/triage-contracts";

let current: Timings = DEFAULT_TIMINGS;

/** Sets the waits the hub runs on, which boot reads from its environment once. */
export function setTimings(timings: Timings): void {
  current = timings;
}

/** The hub's waits: those boot set, else the defaults. */
export function timings(): Timings {
  return current;
}
