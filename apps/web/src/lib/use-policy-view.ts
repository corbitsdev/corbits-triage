import { customRuleId, DEFAULT_SCORE_LEVELS, teamSlug, VERDICTS, type CustomCheck, type Step, type VerdictWord } from "@corbits/triage-contracts";
import type { DraftUpdate } from "./pack-autosave.ts";
import { customProblem, freshStepId, labelProblem, same, setSteps, stepEntries, stepProblem, STEPS_MAX, type RepoDraft, type StepEntry } from "./pack-draft.ts";
import { shownReason } from "./pack-prose.ts";

/** `position` is the step's place among all the verdict's steps, as the contract counts them. */
export type StepRow = { id: string; position: number; step: Step; problem: string | null };

/** `key` stays the same when a first save renames the rule. */
export type JudgementRule = { id: string; key: string; on: boolean; problem: string | null } & (
  | { shape: "is-true"; claim: string }
  | { shape: "score"; subject: string; levels: string[]; failBelow?: string }
);

/** One field of a judgement rule; `failBelow: null` means it never fails. */
export type JudgementPatch = { claim: string } | { subject: string } | { levels: string[] } | { failBelow: string | null };

/** A verdict's label as the Labels card edits it. */
export type VerdictLabel = { name: string; problem: string | null };

export type PolicyView = {
  /** The steps people edit; the failed-rule labels step for anyone belongs to the Labels card. */
  steps: Record<VerdictWord, StepRow[]>;
  rules: JudgementRule[];
  labels: Record<VerdictWord, VerdictLabel>;
  /** Which verdicts label each failed rule. */
  ruleLabels: Record<VerdictWord, boolean>;
  /** Which verdicts hold as many steps as a verdict can. */
  full: Record<VerdictWord, boolean>;
  addStep: (verdict: VerdictWord) => void;
  setStep: (verdict: VerdictWord, id: string, step: Step) => void;
  removeStep: (verdict: VerdictWord, id: string) => void;
  /** Adds the failed-rule labels step to every verdict that lacks it, or removes it from every verdict. */
  setRuleLabels: (on: boolean) => void;
  setLabelName: (verdict: VerdictWord, name: string) => void;
  /** Adds an empty rule and returns its id. */
  addRule: (shape: JudgementRule["shape"]) => string;
  patchRule: (id: string, patch: JudgementPatch) => void;
};

const RULES_LABELS: Step = { do: "labels", target: { from: "rules" } };

function ruleLabelsEntry(entries: StepEntry[]): StepEntry | undefined {
  return entries.find((entry) => same(entry.step, RULES_LABELS));
}

/** People are GitHub logins, which GitHub matches without the @ and whatever their case. */
export function logins(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
}

/** What a step still needs, in the panel's words; null when the contract's reason is the clearer one. */
function stepMissing(step: Step, repo: string): string | null {
  const owner = repo.split("/", 1)[0];
  if (typeof step.for === "object" && "team" in step.for) {
    if (!step.for.team.trim()) return "name the team.";
    if (teamSlug(step.for.team, repo) === null) return `the team must be in ${owner}.`;
  }
  if (typeof step.for === "object" && "users" in step.for && step.for.users.length === 0) return "add the people it is for.";
  if (step.do === "comment" && !step.target.body.trim()) return "write the comment.";
  if (step.do === "labels" && step.target.from === "list" && step.target.labels.length === 0) return "add a label.";
  if ((step.do === "request-review" || step.do === "assign") && "users" in step.target && step.target.users.length === 0) return "add someone.";
  if ((step.do === "request-review" || step.do === "assign") && "teams" in step.target) {
    if (step.target.teams.length === 0) return "add a team.";
    if (step.target.teams.some((team) => teamSlug(team, repo) === null)) return `every team must be in ${owner}.`;
  }
  return null;
}

function ruleMissing(row: CustomCheck): string | null {
  if (row.shape === "is-true" && !row.claim.trim()) return "write the claim.";
  if (row.shape === "score" && !row.subject.trim()) return "say what to score.";
  if (row.shape === "score" && (row.levels.length < 2 || row.levels.length > 10)) return "give it 2 to 10 levels.";
  return null;
}

/** The rule's text names it, so the inbox shows the claim or subject; a blank one keeps the name it had. */
function patched(row: CustomCheck, patch: JudgementPatch): CustomCheck {
  if ("claim" in patch) return row.shape === "is-true" ? { ...row, name: patch.claim.trim() || row.name, claim: patch.claim } : row;
  if (row.shape !== "score") return row;
  if ("subject" in patch) return { ...row, name: patch.subject.trim() || row.name, subject: patch.subject };
  const { failBelow, ...rest } = row;
  if ("levels" in patch) return failBelow !== undefined && patch.levels.slice(1).includes(failBelow) ? { ...rest, levels: patch.levels, failBelow } : { ...rest, levels: patch.levels };
  return patch.failBelow === null ? rest : { ...rest, failBelow: patch.failBelow };
}

const NEW_RULE_NAMES: Record<JudgementRule["shape"], string> = { "is-true": "Is it true", score: "Score" };

/**
 * The repository's steps, judgement rules and verdict labels as the panel edits them. Steps are addressed by their
 * stable id and rules by theirs, so an edit lands on the row it was made on whatever moved around it.
 */
export function usePolicyView(draft: RepoDraft, edit: (update: DraftUpdate) => void): PolicyView {
  const repo = draft.pack.repo;

  function rows(verdict: VerdictWord): StepRow[] {
    const entries = stepEntries(draft, verdict);
    const owned = ruleLabelsEntry(entries)?.id;
    function row(entry: StepEntry, position: number): StepRow[] {
      if (entry.id === owned) return [];
      const problem = stepProblem(draft, verdict, entry.step, position);
      return [{ id: entry.id, position, step: entry.step, problem: problem && (stepMissing(entry.step, repo) ?? problem.replace(/^\w+ step \d+ /, "")) }];
    }
    return entries.flatMap(row);
  }

  function label(verdict: VerdictWord): VerdictLabel {
    const name = draft.pack.labels[verdict];
    return { name, problem: labelProblem(name) };
  }

  function judgementRow(row: CustomCheck): JudgementRule[] {
    const problem = customProblem(draft, row);
    const base = { id: row.id, key: draft.ruleKeys?.[row.id] ?? row.id, on: row.enabled !== false, problem: problem && (ruleMissing(row) ?? shownReason(problem, draft.pack)) };
    if (row.shape === "is-true") return [{ ...base, shape: "is-true", claim: row.claim }];
    if (row.shape === "score") return [{ ...base, shape: "score", subject: row.subject, levels: row.levels, ...(row.failBelow !== undefined && { failBelow: row.failBelow }) }];
    return [];
  }

  function editSteps(verdict: VerdictWord, change: (entries: StepEntry[]) => StepEntry[]) {
    edit((current) => setSteps(current, verdict, change(stepEntries(current, verdict))));
  }

  function addStep(verdict: VerdictWord) {
    const id = freshStepId();
    editSteps(verdict, (entries) => [...entries, { id, step: { do: "approve" } }]);
  }

  function setStep(verdict: VerdictWord, id: string, step: Step) {
    editSteps(verdict, (entries) => entries.map((entry) => (entry.id === id ? { id, step } : entry)));
  }

  function removeStep(verdict: VerdictWord, id: string) {
    editSteps(verdict, (entries) => entries.filter((entry) => entry.id !== id));
  }

  function setRuleLabels(on: boolean) {
    for (const verdict of VERDICTS) {
      editSteps(verdict, function ruleLabels(entries) {
        const owned = ruleLabelsEntry(entries);
        if (!on) return owned ? entries.filter((entry) => entry.id !== owned.id) : entries;
        return owned ? entries : [...entries, { id: freshStepId(), step: RULES_LABELS }];
      });
    }
  }

  function setLabelName(verdict: VerdictWord, name: string) {
    edit((current) => ({ ...current, pack: { ...current.pack, labels: { ...current.pack.labels, [verdict]: name } } }));
  }

  function addRule(shape: JudgementRule["shape"]): string {
    let id = "";
    edit(function added(current) {
      id = customRuleId(NEW_RULE_NAMES[shape], current.pack.custom.map((row) => row.id));
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
  const labels = Object.fromEntries(VERDICTS.map((verdict) => [verdict, label(verdict)])) as Record<VerdictWord, VerdictLabel>;
  const ruleLabels = Object.fromEntries(VERDICTS.map((verdict) => [verdict, ruleLabelsEntry(stepEntries(draft, verdict)) !== undefined])) as Record<VerdictWord, boolean>;
  const full = Object.fromEntries(VERDICTS.map((verdict) => [verdict, draft.pack.actions[verdict].length >= STEPS_MAX])) as Record<VerdictWord, boolean>;
  return { steps, rules: draft.pack.custom.flatMap(judgementRow), labels, ruleLabels, full, addStep, setStep, removeStep, setRuleLabels, setLabelName, addRule, patchRule };
}
