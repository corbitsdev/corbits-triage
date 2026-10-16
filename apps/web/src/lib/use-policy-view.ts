import { DEFAULT_SCORE_LEVELS, teamSlug, textSentence, VERDICTS, type CustomCheck, type ModelCustomCheck, type Step, type TextCheck, type TextCustomCheck, type VerdictWord } from "@corbits/triage-contracts";
import type { DraftUpdate } from "./pack-autosave.ts";
import { customProblem, freshRuleId, freshStepId, labelProblem, same, setSteps, stepEntries, stepProblem, STEPS_MAX, type RepoDraft, type StepEntry } from "./pack-draft.ts";
import { shownReason } from "./pack-prose.ts";
import { stepFor } from "./policy-view.ts";

export type StepRow = { id: string; position: number; step: Step; problem: string | null };

/** `key` stays the same when a first save renames the rule. */
export type JudgementRule = { id: string; key: string; on: boolean; problem: string | null } & (
  | { shape: "is-true"; claim: string }
  | { shape: "score"; subject: string; levels: string[]; failBelow?: string }
);

export type JudgementPatch = { claim: string } | { subject: string } | { levels: string[] } | { failBelow: string | null };

export type TextRule = { id: string; key: string; on: boolean; problem: string | null } & TextCheck;

export type VerdictLabel = { name: string; problem: string | null };

export type PolicyView = {
  steps: Record<VerdictWord, StepRow[]>;
  rules: JudgementRule[];
  textRules: TextRule[];
  labels: Record<VerdictWord, VerdictLabel>;
  ruleLabels: Record<VerdictWord, boolean>;
  full: Record<VerdictWord, boolean>;
  addStep: (verdict: VerdictWord) => void;
  setStep: (verdict: VerdictWord, id: string, step: Step) => void;
  removeStep: (verdict: VerdictWord, id: string) => void;
  setRuleLabels: (on: boolean) => void;
  setLabelName: (verdict: VerdictWord, name: string) => void;
  addRule: (shape: JudgementRule["shape"]) => string;
  patchRule: (id: string, patch: JudgementPatch) => void;
  addTextRule: () => string;
  patchTextRule: (id: string, patch: Partial<TextCheck>) => void;
};

const RULES_LABELS: Step = { do: "labels", target: { from: "rules" } };

function ruleLabelsEntry(entries: StepEntry[]): StepEntry | undefined {
  return entries.find((entry) => same(entry.step, RULES_LABELS));
}

export function logins(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
}

function stepMissing(step: Step, repo: string): string | null {
  const owner = repo.split("/", 1)[0];
  const match = stepFor(step);
  if (typeof match === "object" && "team" in match) {
    if (!match.team.trim()) return "name the team.";
    if (teamSlug(match.team, repo) === null) return `the team must be in ${owner}.`;
  }
  if (typeof match === "object" && "users" in match && match.users.length === 0) return "add the people it is for.";
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
  if (row.kind === "text") return row.phrases.length === 0 ? "add a phrase." : null;
  if (row.shape === "is-true" && !row.claim.trim()) return "write the claim.";
  if (row.shape === "score" && !row.subject.trim()) return "say what to score.";
  if (row.shape === "score" && (row.levels.length < 2 || row.levels.length > 10)) return "give it 2 to 10 levels.";
  return null;
}

/** The rule's text names it, so the inbox shows the claim or subject; a blank one keeps the name it had. */
function patched(row: ModelCustomCheck, patch: JudgementPatch): ModelCustomCheck {
  if ("claim" in patch) return row.shape === "is-true" ? { ...row, name: patch.claim.trim() || row.name, claim: patch.claim } : row;
  if (row.shape !== "score") return row;
  if ("subject" in patch) return { ...row, name: patch.subject.trim() || row.name, subject: patch.subject };
  const { failBelow, ...rest } = row;
  if ("levels" in patch) return failBelow !== undefined && patch.levels.slice(1).includes(failBelow) ? { ...rest, levels: patch.levels, failBelow } : { ...rest, levels: patch.levels };
  return patch.failBelow === null ? rest : { ...rest, failBelow: patch.failBelow };
}

/** A text rule is named by its sentence, cut to a length a name holds. */
function patchedText(row: TextCustomCheck, patch: Partial<TextCheck>): TextCustomCheck {
  const next = { ...row, ...patch };
  return { ...next, name: textSentence(next).slice(0, NAME_MAX) };
}

const NAME_MAX = 120;

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

  function ruleBase(row: CustomCheck) {
    const problem = customProblem(draft, row);
    return { id: row.id, key: draft.ruleKeys?.[row.id] ?? row.id, on: row.enabled !== false, problem: problem && (ruleMissing(row) ?? shownReason(problem, draft.pack)) };
  }

  function judgementRow(row: CustomCheck): JudgementRule[] {
    if (row.kind === "text") return [];
    const base = ruleBase(row);
    if (row.shape === "is-true") return [{ ...base, shape: "is-true", claim: row.claim }];
    if (row.shape === "score") return [{ ...base, shape: "score", subject: row.subject, levels: row.levels, ...(row.failBelow !== undefined && { failBelow: row.failBelow }) }];
    return [];
  }

  function textRow(row: CustomCheck): TextRule[] {
    return row.kind === "text" ? [{ ...ruleBase(row), fields: row.fields, failWhen: row.failWhen, phrases: row.phrases }] : [];
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
      id = freshRuleId(current, NEW_RULE_NAMES[shape]);
      const base = { id, name: NEW_RULE_NAMES[shape], group: "pull-request" as const, kind: "model" as const };
      const row: ModelCustomCheck = shape === "is-true" ? { ...base, shape, claim: "" } : { ...base, shape, subject: "", levels: [...DEFAULT_SCORE_LEVELS] };
      return { ...current, pack: { ...current.pack, custom: [...current.pack.custom, row] } };
    });
    return id;
  }

  function patchRule(id: string, patch: JudgementPatch) {
    edit((current) => ({ ...current, pack: { ...current.pack, custom: current.pack.custom.map((row) => (row.id === id && row.kind === "model" ? patched(row, patch) : row)) } }));
  }

  function addTextRule(): string {
    let id = "";
    edit(function added(current) {
      const row = patchedText({ id: "", name: "", group: "pull-request", kind: "text", fields: ["commits"], failWhen: "contains", phrases: [] }, {});
      id = freshRuleId(current, "Fail when");
      return { ...current, pack: { ...current.pack, custom: [...current.pack.custom, { ...row, id }] } };
    });
    return id;
  }

  function patchTextRule(id: string, patch: Partial<TextCheck>) {
    edit((current) => ({ ...current, pack: { ...current.pack, custom: current.pack.custom.map((row) => (row.id === id && row.kind === "text" ? patchedText(row, patch) : row)) } }));
  }

  const steps = Object.fromEntries(VERDICTS.map((verdict) => [verdict, rows(verdict)])) as Record<VerdictWord, StepRow[]>;
  const labels = Object.fromEntries(VERDICTS.map((verdict) => [verdict, label(verdict)])) as Record<VerdictWord, VerdictLabel>;
  const ruleLabels = Object.fromEntries(VERDICTS.map((verdict) => [verdict, ruleLabelsEntry(stepEntries(draft, verdict)) !== undefined])) as Record<VerdictWord, boolean>;
  const full = Object.fromEntries(VERDICTS.map((verdict) => [verdict, draft.pack.actions[verdict].length >= STEPS_MAX])) as Record<VerdictWord, boolean>;
  return { steps, rules: draft.pack.custom.flatMap(judgementRow), textRules: draft.pack.custom.flatMap(textRow), labels, ruleLabels, full, addStep, setStep, removeStep, setRuleLabels, setLabelName, addRule, patchRule, addTextRule, patchTextRule };
}
