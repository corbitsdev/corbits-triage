// The manager's pass loop. Each fn is pure: it reads a finished pass's step outputs, keyed by step id.
import { asRecord } from "@corbits/common";

const DONES = ["done", "donePosted", "doneAwaiting", "doneReviewing", "doneJudging"];

/** The pass's done, on whichever branch it ran. The loop reads a pass's outputs from its log, where each done it skipped holds the gate's skip marker. */
function doneOf(output: unknown): Record<string, unknown> | undefined {
  const steps = asRecord(output);
  return DONES.map((id) => asRecord(steps?.[id])).find((done) => done !== undefined && done["skipped"] !== true);
}

/** Another pass while done answers `more`. */
export function again(output: unknown): boolean {
  return doneOf(output)?.["outcome"] === "more";
}

/** The next pass works from the same mail, after polling for what its head awaits when done says to. */
export function next(output: unknown, input: unknown): { payload: unknown; wait: boolean } {
  return { payload: asRecord(input)?.["payload"], wait: doneOf(output)?.["wait"] === true };
}
