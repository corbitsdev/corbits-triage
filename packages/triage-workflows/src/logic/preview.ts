import { evaluateAction, type ActionInput, type Branch, type SuggestedAction } from "./actions.js";
import type { CheckResult } from "./checks.js";
import { NEEDS_JUDGE_REASON } from "./render.js";

export type BranchPreview = { branch: Branch; reason: string; dos: SuggestedAction[] };

export type ActionPreview =
  | { id: string; status: "not-woken" }
  | { id: string; status: "skipped"; reason: string }
  | ({ id: string; status: "decided" } & BranchPreview)
  | { id: string; status: "waits-on-judge"; branches: BranchPreview[] };

const JUDGE_ANSWERS: CheckResult["result"][] = ["pass", "fail", "unconfirmed"];

function answered(checks: CheckResult[], result: CheckResult["result"]): CheckResult[] {
  return checks.map((c) => (c.kind === "model" && c.reason === NEEDS_JUDGE_REASON ? { ...c, result } : c));
}

/** Each action's outcome whatever the judge answers: decided when every answer takes the same branch, else the branches it could take. */
export function previewActions(input: ActionInput): ActionPreview[] {
  const inputs = JUDGE_ANSWERS.map((result) => ({ ...input, checks: answered(input.checks, result) }));
  return input.pack.actions.map(function preview(action): ActionPreview {
    const taken: BranchPreview[] = [];
    for (const each of inputs) {
      const outcome = evaluateAction(action, each);
      if (outcome === undefined) return { id: action.id, status: "not-woken" };
      if ("skipped" in outcome) return { id: action.id, status: "skipped", reason: outcome.skipped };
      taken.push(outcome);
    }
    const branches = taken.filter((outcome, i) => taken.findIndex((other) => other.branch === outcome.branch) === i);
    // Unconfirmed is what the checks hold until the judge answers, so a decided action reports that outcome.
    if (branches.length === 1) return { id: action.id, status: "decided", ...taken.at(-1)! };
    return { id: action.id, status: "waits-on-judge", branches };
  });
}
