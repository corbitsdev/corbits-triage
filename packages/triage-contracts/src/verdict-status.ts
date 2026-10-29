import { ruleLabel, WAITING_LABEL, type VerdictWord } from "./check-pack.js";

/** The verdict as a status on the head, which a host shows beside it and can require before merge; each host maps the state to its own. */
type StatusState = "success" | "failure" | "pending" | "error";
export type VerdictStatus = { state: StatusState; description: string };

const STATUS_STATES: Record<VerdictWord, StatusState> = { pass: "success", fail: "failure", unsure: "pending" };
const STATUS_WORDS: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Needs review" };

/** The status naming the failed rules the way their labels would on a host with labels. */
export function verdictStatus(verdict: VerdictWord, failedRules: readonly string[]): VerdictStatus {
  const word = STATUS_WORDS[verdict];
  return { state: STATUS_STATES[verdict], description: failedRules.length ? `${word}: ${failedRules.map(ruleLabel).join(", ")}` : word };
}

/** On a head held for its CI until the verdict replaces it. */
export const WAITING_STATUS: VerdictStatus = { state: "pending", description: WAITING_LABEL };

/** On a head Triage could not read. */
export const UNREAD_STATUS: VerdictStatus = { state: "error", description: "Triage couldn't run" };
