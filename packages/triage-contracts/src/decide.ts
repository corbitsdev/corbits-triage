import { VERDICTS, type VerdictWord } from "./check-pack.js";
import { kindsOf, type DecideRule } from "./policy-workflow.js";

function approves(rule: DecideRule): boolean {
  const kinds = kindsOf(rule.do);
  return kinds.includes("approve") || kinds.includes("merge");
}

/** The triage verdicts a rule matches; one that approves or merges without naming any matches only Pass. */
export function ruleVerdicts(rule: DecideRule): readonly VerdictWord[] {
  if (rule.if.triage !== undefined) return [rule.if.triage].flat();
  return approves(rule) ? ["pass"] : VERDICTS;
}
