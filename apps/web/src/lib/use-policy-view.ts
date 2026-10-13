import { useRef } from "react";
import { customRuleId, VERDICTS, type CustomCheck, type VerdictWord } from "@corbits/triage-contracts";
import type { DraftUpdate } from "./pack-autosave.ts";
import { customProblem, doProblem, setList, type RepoDraft } from "./pack-draft.ts";
import { shownReason } from "./pack-prose.ts";
import { doOf, judgementOf, NEW_RULE_NAMES, NOT_YET, patchJudgementRule, STORES, stepsOf, withNewJudgementRule } from "./policy-adapter.ts";
import type { JudgementPatch, JudgementRule, Step } from "./policy-view.ts";

export type StepRow = { key: string; step: Step; problem: string | null };
export type JudgementRow = JudgementRule & { problem: string | null };

export type PolicyView = {
  steps: Record<VerdictWord, StepRow[]>;
  rules: JudgementRow[];
  /** What the stored policy cannot hold yet, and why its control is disabled. */
  stores: typeof STORES;
  notYet: string;
  addStep: (verdict: VerdictWord) => void;
  setStep: (verdict: VerdictWord, index: number, step: Step) => void;
  removeStep: (verdict: VerdictWord, index: number) => void;
  /** Adds an empty rule and returns its id. */
  addRule: (shape: JudgementRule["shape"]) => string;
  patchRule: (id: string, patch: JudgementPatch) => void;
};

/** What a step still needs, in the panel's words; null when the contract's reason is the clearer one. */
function stepMissing(step: Step): string | null {
  if (step.do === "comment" && !step.body.trim()) return "write the comment.";
  if (step.do === "labels" && step.labels.from === "list" && step.labels.labels.length === 0) return "add a label.";
  if ((step.do === "request-review" || step.do === "assign") && "users" in step.who && step.who.users.length === 0) return "add someone.";
  if ((step.do === "request-review" || step.do === "assign") && "teams" in step.who && step.who.teams.length === 0) return "add a team.";
  return null;
}

function ruleMissing(rule: JudgementRule): string | null {
  if (rule.shape === "is-true" && !rule.claim.trim()) return "write the claim.";
  if (rule.shape === "score" && !rule.subject.trim()) return "say what to score.";
  return null;
}

function replaced<T>(items: T[], index: number, item: T): T[] {
  return items.map((current, i) => (i === index ? item : current));
}

/**
 * The repository's steps and judgement rules as the panel edits them. Every edit is a patch against the draft as it
 * is when it applies (one step by index, one rule field by id), so replaying it after a conflict keeps other changes.
 */
export function usePolicyView(draft: RepoDraft, edit: (update: DraftUpdate) => void): PolicyView {
  const keys = useRef<Record<VerdictWord, string[]>>({ pass: [], fail: [], unsure: [] });
  const next = useRef(0);

  function fresh(): string {
    next.current += 1;
    return `step-${next.current}`;
  }

  function rows(verdict: VerdictWord): StepRow[] {
    const steps = stepsOf(draft.pack, verdict);
    if (keys.current[verdict].length !== steps.length) keys.current[verdict] = steps.map(fresh);
    function row(step: Step, index: number): StepRow {
      const problem = doProblem(draft, verdict, draft.pack.actions[verdict][index]!);
      return { key: keys.current[verdict][index]!, step, problem: problem && (stepMissing(step) ?? problem.replace(/^Actions \w+ \d+ /, "")) };
    }
    return steps.map(row);
  }

  function judgementRow(row: CustomCheck): JudgementRow[] {
    const rule = judgementOf(row);
    if (!rule) return [];
    const problem = customProblem(draft, row);
    return [{ ...rule, problem: problem && (ruleMissing(rule) ?? shownReason(problem, draft.pack)) }];
  }

  const rules = draft.pack.custom.flatMap(judgementRow);

  function addStep(verdict: VerdictWord) {
    keys.current[verdict] = [...keys.current[verdict], fresh()];
    edit((current) => setList(current, verdict, [...current.pack.actions[verdict], doOf({ do: "approve", for: "anyone" })]));
  }

  function setStep(verdict: VerdictWord, index: number, step: Step) {
    edit((current) => setList(current, verdict, replaced(current.pack.actions[verdict], index, doOf(step))));
  }

  function removeStep(verdict: VerdictWord, index: number) {
    keys.current[verdict] = keys.current[verdict].filter((_, i) => i !== index);
    edit((current) => setList(current, verdict, current.pack.actions[verdict].filter((_, i) => i !== index)));
  }

  function addRule(shape: JudgementRule["shape"]): string {
    const id = customRuleId(NEW_RULE_NAMES[shape], draft.pack.custom.map((row) => row.id));
    edit((current) => ({ ...current, pack: withNewJudgementRule(current.pack, shape, id) }));
    return id;
  }

  function patchRule(id: string, patch: JudgementPatch) {
    edit((current) => ({ ...current, pack: patchJudgementRule(current.pack, id, patch) }));
  }

  const steps = Object.fromEntries(VERDICTS.map((verdict) => [verdict, rows(verdict)])) as Record<VerdictWord, StepRow[]>;
  return { steps, rules, stores: STORES, notYet: NOT_YET, addStep, setStep, removeStep, addRule, patchRule };
}
