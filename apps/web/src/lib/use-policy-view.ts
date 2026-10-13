import { useRef } from "react";
import { customRuleId, DEFAULT_SCORE_LEVELS, VERDICTS, type CheckPack, type CustomCheck, type Step, type VerdictWord } from "@corbits/triage-contracts";
import type { DraftUpdate } from "./pack-autosave.ts";
import { customProblem, setList, stepProblem, type RepoDraft } from "./pack-draft.ts";
import { shownReason } from "./pack-prose.ts";
import { isHandoffLabels } from "./policy-view.ts";

/** `index` is the step's place in the verdict's stored list. */
export type StepRow = { key: string; index: number; step: Step; problem: string | null };

export type JudgementRule = { id: string; on: boolean; problem: string | null } & (
  | { shape: "is-true"; claim: string }
  | { shape: "score"; subject: string; levels: string[]; failBelow?: string }
);

/** One field of a judgement rule; `failBelow: null` means it never fails. */
export type JudgementPatch = { claim?: string } | { subject?: string } | { levels: string[] } | { failBelow: string | null };

export type PolicyView = {
  /** The steps people edit; the verdict and failed-rule labels belong to the Labels card. */
  steps: Record<VerdictWord, StepRow[]>;
  rules: JudgementRule[];
  /** Every verdict labels itself and each failed rule. */
  handoffLabels: boolean;
  addStep: (verdict: VerdictWord) => void;
  setStep: (verdict: VerdictWord, index: number, step: Step) => void;
  removeStep: (verdict: VerdictWord, index: number) => void;
  setHandoffLabels: (on: boolean) => void;
  /** Adds an empty rule and returns its id. */
  addRule: (shape: JudgementRule["shape"]) => string;
  patchRule: (id: string, patch: JudgementPatch) => void;
};

const HANDOFF: Step[] = [{ do: "labels", target: { from: "verdict" } }, { do: "labels", target: { from: "rules" } }];

/** What a step still needs, in the panel's words; null when the contract's reason is the clearer one. */
function stepMissing(step: Step): string | null {
  if (typeof step.for === "object" && "team" in step.for && !step.for.team.trim()) return "name the team.";
  if (typeof step.for === "object" && "users" in step.for && step.for.users.length === 0) return "add the people it is for.";
  if (step.do === "comment" && !step.target.body.trim()) return "write the comment.";
  if (step.do === "labels" && step.target.from === "list" && step.target.labels.length === 0) return "add a label.";
  if ((step.do === "request-review" || step.do === "assign") && "users" in step.target && step.target.users.length === 0) return "add someone.";
  if ((step.do === "request-review" || step.do === "assign") && "teams" in step.target && step.target.teams.length === 0) return "add a team.";
  return null;
}

function ruleMissing(row: CustomCheck): string | null {
  if (row.shape === "is-true" && !row.claim.trim()) return "write the claim.";
  if (row.shape === "score" && !row.subject.trim()) return "say what to score.";
  if (row.shape === "score" && (row.levels.length < 2 || row.levels.length > 10)) return "give it 2 to 10 levels.";
  return null;
}

function replaced<T>(items: T[], index: number, item: T): T[] {
  return items.map((current, i) => (i === index ? item : current));
}

function hasHandoff(pack: CheckPack, verdict: VerdictWord): boolean {
  return HANDOFF.every((label) => pack.actions[verdict].some((step) => JSON.stringify(step) === JSON.stringify(label)));
}

/** The rule's text names it, so the inbox shows the claim or subject; a blank one keeps the name it had. */
function patched(row: CustomCheck, patch: JudgementPatch): CustomCheck {
  if ("claim" in patch && patch.claim !== undefined && row.shape === "is-true") return { ...row, name: patch.claim.trim() || row.name, claim: patch.claim };
  if (row.shape !== "score") return row;
  if ("subject" in patch && patch.subject !== undefined) return { ...row, name: patch.subject.trim() || row.name, subject: patch.subject };
  if ("levels" in patch) {
    const { failBelow, ...rest } = row;
    return patch.levels.slice(1).includes(failBelow ?? "") ? { ...rest, levels: patch.levels, failBelow } : { ...rest, levels: patch.levels };
  }
  if ("failBelow" in patch) {
    const { failBelow: _was, ...rest } = row;
    return patch.failBelow === null ? rest : { ...rest, failBelow: patch.failBelow };
  }
  return row;
}

const NEW_RULE_NAMES: Record<JudgementRule["shape"], string> = { "is-true": "Is it true", score: "Score" };

/**
 * The repository's steps, judgement rules and handoff labels as the panel edits them. Every edit is a patch against
 * the draft as it is when it applies (one step by index, one rule field by id), so replaying it after a conflict keeps
 * other changes.
 */
export function usePolicyView(draft: RepoDraft, edit: (update: DraftUpdate) => void): PolicyView {
  const keys = useRef<Record<VerdictWord, string[]>>({ pass: [], fail: [], unsure: [] });
  const next = useRef(0);

  function fresh(): string {
    next.current += 1;
    return `step-${next.current}`;
  }

  function rows(verdict: VerdictWord): StepRow[] {
    const all = draft.pack.actions[verdict];
    if (keys.current[verdict].length !== all.length) keys.current[verdict] = all.map(fresh);
    function row(step: Step, index: number): StepRow[] {
      if (isHandoffLabels(step)) return [];
      const problem = stepProblem(draft, verdict, step);
      return [{ key: keys.current[verdict][index]!, index, step, problem: problem && (stepMissing(step) ?? problem.replace(/^\w+ step \d+ /, "")) }];
    }
    return all.flatMap(row);
  }

  function judgementRow(row: CustomCheck): JudgementRule[] {
    const problem = customProblem(draft, row);
    const base = { id: row.id, on: row.enabled !== false, problem: problem && (ruleMissing(row) ?? shownReason(problem, draft.pack)) };
    if (row.shape === "is-true") return [{ ...base, shape: "is-true", claim: row.claim }];
    if (row.shape === "score") return [{ ...base, shape: "score", subject: row.subject, levels: row.levels, ...(row.failBelow !== undefined && { failBelow: row.failBelow }) }];
    return [];
  }

  function addStep(verdict: VerdictWord) {
    keys.current[verdict] = [...keys.current[verdict], fresh()];
    edit((current) => setList(current, verdict, [...current.pack.actions[verdict], { do: "approve" }]));
  }

  function setStep(verdict: VerdictWord, index: number, step: Step) {
    edit((current) => setList(current, verdict, replaced(current.pack.actions[verdict], index, step)));
  }

  function removeStep(verdict: VerdictWord, index: number) {
    keys.current[verdict] = keys.current[verdict].filter((_, i) => i !== index);
    edit((current) => setList(current, verdict, current.pack.actions[verdict].filter((_, i) => i !== index)));
  }

  /** Adds or removes both handoff labels steps on every verdict, leaving the other steps where they are. */
  function setHandoffLabels(on: boolean) {
    edit(function handoff(current) {
      let result = current;
      for (const verdict of VERDICTS) {
        const kept = result.pack.actions[verdict].filter((step) => !isHandoffLabels(step));
        result = setList(result, verdict, on ? [...kept, ...HANDOFF] : kept);
      }
      return result;
    });
  }

  function addRule(shape: JudgementRule["shape"]): string {
    const id = customRuleId(NEW_RULE_NAMES[shape], draft.pack.custom.map((row) => row.id));
    edit(function added(current) {
      if (current.pack.custom.some((row) => row.id === id)) return current;
      const base = { id, name: NEW_RULE_NAMES[shape], group: "pull-request" as const, kind: "model" as const };
      const row: CustomCheck = shape === "is-true" ? { ...base, shape, claim: "" } : { ...base, shape, subject: "", levels: [...DEFAULT_SCORE_LEVELS] };
      return { ...current, pack: { ...current.pack, custom: [...current.pack.custom, row] } };
    });
    return id;
  }

  function patchRule(id: string, patch: JudgementPatch) {
    edit((current) => ({ ...current, pack: { ...current.pack, custom: current.pack.custom.map((row) => (row.id === id ? patched(row, patch) : row)) } }));
  }

  const steps = Object.fromEntries(VERDICTS.map((verdict) => [verdict, rows(verdict)])) as Record<VerdictWord, StepRow[]>;
  const handoffLabels = VERDICTS.every((verdict) => hasHandoff(draft.pack, verdict));
  return { steps, rules: draft.pack.custom.flatMap(judgementRow), handoffLabels, addStep, setStep, removeStep, setHandoffLabels, addRule, patchRule };
}
