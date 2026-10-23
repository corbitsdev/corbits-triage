import { type } from "arktype";
import { BUILT_IN_CHECK_NAMES, NOT_A_DRAFT } from "./check-pack.js";

/** A block's `when.rules`: `pass` runs it only once the policy's rules have passed, `any` whatever they say. */
export const RULE_GATES = ["pass", "any"] as const;
export type RuleGate = (typeof RULE_GATES)[number];

export type RuleOutcome = { check: string; kind: string; result: string; onFail?: string };

/** A rule read without a model whose failure fails the pull request. */
function failsPullRequest(check: RuleOutcome): boolean {
  return check.kind === "machine" && check.onFail === undefined;
}

/** None on a draft, which is not decided at all; a rule whose failure goes to a maintainer is not one. */
export function hardFailures<T extends RuleOutcome>(checks: readonly T[]): T[] {
  const failed = checks.filter((check) => failsPullRequest(check) && check.result === "fail");
  return failed.some((check) => check.check === NOT_A_DRAFT) ? [] : failed;
}

const Checks = type({ check: "string", kind: "string", result: "string", "onFail?": "string" }).array();

export type RulesGate = { open: true } | { open: false; outcome: "skipped" | "incomplete"; reason: string };

/**
 * Whether a block runs past triage's rules, from the verdict's `checks`. Under `pass` only the policy's own rules read
 * without a model whose failure fails the pull request count, CI's among them when `ci-green` is one: a failed one keeps
 * the block shut, and so does one not known yet, such as CI still running, or checks that cannot be read. Triage's
 * built-in rules never shut it.
 */
export function rulesGate(when: RuleGate, checks: unknown): RulesGate {
  if (when === "any") return { open: true };
  const parsed = Checks(checks);
  if (parsed instanceof type.errors) return { open: false, outcome: "incomplete", reason: "triage gave no rule results" };
  const policy = parsed.filter((check) => failsPullRequest(check) && !BUILT_IN_CHECK_NAMES.has(check.check));
  const failed = hardFailures(policy).map((check) => check.check);
  if (failed.length > 0) return { open: false, outcome: "skipped", reason: `rules failed: ${failed.join(", ")}` };
  const unknown = policy.filter((check) => check.result !== "pass").map((check) => check.check);
  if (unknown.length > 0) return { open: false, outcome: "incomplete", reason: `rules not settled yet: ${unknown.join(", ")}` };
  return { open: true };
}
