import { isRecord } from "@corbits/common";
import { ciRefusal } from "@corbits/github-reads";
import { hardFailures, NOT_A_DRAFT } from "@corbits/triage-contracts";
import type { CheckResult } from "./checks.js";
import { CI_NOT_PASSED } from "./actions.js";
import { QUALITY_EVALUATION_LIMIT_ERROR } from "./quality.js";
import { NEEDS_JUDGE_REASON, NOT_ASKED_REASON } from "./render.js";

/** A verdict whose model checks were all skipped; the hub triages a settled head again for it once, whatever attempts it spent. */
export const MODEL_NOT_ASKED = "model not asked";

/** Opens the reason of a verdict whose policy the hub could not read; a run again changes nothing until the policy does. */
export const POLICY_UNREADABLE = "Policy can't be read: ";

/** `unconfirmed` when GitHub had not computed a machine check yet. */
export type Unsettled = { unsettled?: string; unconfirmed?: true };

type VerdictFields = { degraded?: unknown; reason?: unknown; headSha?: unknown; state?: unknown; checks?: unknown; waiting?: unknown };

function checksOf(verdict: VerdictFields): Array<Record<string, unknown>> {
  return Array.isArray(verdict.checks) ? verdict.checks.filter(isRecord) : [];
}

function isUnconfirmedMachineCheck(check: Record<string, unknown>): boolean {
  // `gate` marks an author rule on a verdict recorded before author rules were removed. Running checks are not
  // retried: the completed check_run webhook triages the head again.
  return check["kind"] === "machine" && check["result"] === "unconfirmed" && check["gate"] !== true && check["check"] !== "ci-green";
}

/** Every model check of the verdict was skipped, outside a stale-unknown verdict, a failed hard rule or a draft, which skip them by design. */
function modelNotAsked(verdict: VerdictFields, checks: Array<Record<string, unknown>>): boolean {
  const model = checks.filter((check) => check["kind"] === "model");
  const draft = checks.some((check) => check["check"] === NOT_A_DRAFT && check["result"] === "fail");
  return verdict.state !== "stale-unknown" && !draft && hardFailures(checks as Array<Pick<CheckResult, "check" | "kind" | "result">>).length === 0 && model.length > 0 && model.every((check) => check["reason"] === NOT_ASKED_REASON);
}

/** Why the verdict does not settle `headSha`, when given, or its own head: degraded, made on another commit, a machine check GitHub had not computed yet, or the decision model never asked. */
export function unsettledBy(verdict: VerdictFields, headSha?: string): Unsettled {
  const degraded = verdict.degraded;
  if (degraded !== undefined && degraded !== null) {
    const reason = verdict.reason;
    if (typeof reason === "string" && reason.startsWith(POLICY_UNREADABLE)) return {};
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

/** The verdict waited for CI still running on its head, so the hub holds the head for its CI as one it held itself. */
export function heldForCi(verdict: VerdictFields): boolean {
  return verdict.waiting === true && checksOf(verdict).some((check) => check["check"] === "ci-green" && check["result"] === "unconfirmed");
}

function unasked(reason: unknown): boolean {
  return reason === NEEDS_JUDGE_REASON || String(reason).startsWith(QUALITY_EVALUATION_LIMIT_ERROR);
}

/** A skipped or over-budget judge left a model check or the verdict question unanswered: the verdict still stands, so the head settles, but it was not decided. */
function modelUnanswered(verdict: VerdictFields, checks: Array<Record<string, unknown>>): boolean {
  return unasked(verdict.reason) || checks.some((check) => check["kind"] === "model" && check["result"] === "unconfirmed" && unasked(check["reason"]));
}

/** Only a verdict that settles its head with every model check answered runs Dos unattended. */
export function decidesDos(verdict: VerdictFields): boolean {
  return unsettledBy(verdict).unsettled === undefined && !modelUnanswered(verdict, checksOf(verdict));
}

/** Why a Do waits on the head's CI: held for CI that has not passed, or an approve skipped until it does. */
const CI_REASONS: ReadonlySet<unknown> = new Set([...(["failure", "pending", "cancelled", "none"] as const).map((ci) => `${ciRefusal(ci)}.`), CI_NOT_PASSED]);

/**
 * A verdict made on `headSha` that nothing on the host can still change: it does not wait, settles its head with every
 * model check answered, confirmed every machine check, CI included, and holds or skips no Do for the head's CI, which
 * a run of CI on the same head can still change.
 */
export function decided(verdict: VerdictFields & { actions?: unknown }, headSha: string): boolean {
  const actions = Array.isArray(verdict.actions) ? verdict.actions.filter(isRecord) : [];
  return verdict.headSha === headSha && verdict.waiting !== true && decidesDos(verdict)
    && !checksOf(verdict).some((check) => check["kind"] === "machine" && check["result"] === "unconfirmed")
    && !actions.some((action) => CI_REASONS.has(action["reason"]));
}
