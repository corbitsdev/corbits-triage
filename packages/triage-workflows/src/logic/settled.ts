import { isRecord } from "@corbits/common";
import { QUALITY_EVALUATION_LIMIT_ERROR } from "./quality.js";
import { NEEDS_JUDGE_REASON, NOT_ASKED_REASON } from "./render.js";

/** A verdict whose model checks were all skipped; the hub triages a settled head again for it once, whatever attempts it spent. */
export const MODEL_NOT_ASKED = "model not asked";

/** Why a verdict leaves its head untriaged; `unconfirmed` when GitHub had not computed a machine check yet. */
export type Unsettled = { unsettled?: string; unconfirmed?: true };

/** A verdict as the workflow outputs it or as the hub reads it back from the run log. */
type VerdictFields = { degraded?: unknown; reason?: unknown; headSha?: unknown; state?: unknown; checks?: unknown };

function checksOf(verdict: VerdictFields): Array<Record<string, unknown>> {
  return Array.isArray(verdict.checks) ? verdict.checks.filter(isRecord) : [];
}

function isUnconfirmedMachineCheck(check: Record<string, unknown>): boolean {
  return check["kind"] === "machine" && check["result"] === "unconfirmed" && check["gate"] !== true;
}

/** Every model check of the verdict was skipped, outside a stale-unknown verdict that skips them by design. */
function modelNotAsked(verdict: VerdictFields, checks: Array<Record<string, unknown>>): boolean {
  const model = checks.filter((check) => check["kind"] === "model");
  return verdict.state !== "stale-unknown" && model.length > 0 && model.every((check) => check["reason"] === NOT_ASKED_REASON);
}

/** Why the verdict does not settle `headSha`, when given, or its own head: degraded, made on another commit, a machine check GitHub had not computed yet, or the decision model never asked. */
export function unsettledBy(verdict: VerdictFields, headSha?: string): Unsettled {
  const degraded = verdict.degraded;
  if (degraded !== undefined && degraded !== null) {
    const reason = verdict.reason;
    return { unsettled: `degraded: ${typeof reason === "string" && reason !== "" ? reason : String(degraded)}` };
  }
  const made = verdict.headSha;
  // A verdict from before heads were stamped settles.
  if (headSha !== undefined && typeof made === "string" && made !== headSha) return { unsettled: `verdict made on head ${made}` };
  const checks = checksOf(verdict);
  const unconfirmed = checks.filter(isUnconfirmedMachineCheck).map((check) => String(check["check"]));
  if (unconfirmed.length > 0) return { unsettled: `unconfirmed checks: ${unconfirmed.join(", ")}`, unconfirmed: true };
  if (modelNotAsked(verdict, checks)) return { unsettled: MODEL_NOT_ASKED };
  return {};
}

/** A model check a skipped or over-budget judge left unanswered: the verdict still stands, so the head settles, but its branches were not decided. */
function modelUnanswered(checks: Array<Record<string, unknown>>): boolean {
  return checks.some((check) => check["kind"] === "model" && check["result"] === "unconfirmed" && (check["reason"] === NEEDS_JUDGE_REASON || String(check["reason"]).startsWith(QUALITY_EVALUATION_LIMIT_ERROR)));
}

/** Dos run unattended only on a verdict that settles its head with every model check answered. */
export function decidesDos(verdict: VerdictFields): boolean {
  return unsettledBy(verdict).unsettled === undefined && !modelUnanswered(checksOf(verdict));
}
