import { customRuleId, DEFAULT_SCORE_LEVELS, teamSlug, VERDICTS, verdictLabel, type CustomCheck, type Step, type VerdictWord } from "@corbits/triage-contracts";
import type { DraftUpdate } from "./pack-autosave.ts";
import { customProblem, freshStepId, same, setSteps, stepEntries, stepProblem, type RepoDraft, type StepEntry } from "./pack-draft.ts";
import { shownReason } from "./pack-prose.ts";

export type StepRow = { id: string; step: Step; problem: string | null };

/** `key` stays the same when a first save renames the rule. */
export type JudgementRule = { id: string; key: string; on: boolean; problem: string | null } & (
  | { shape: "is-true"; claim: string }
  | { shape: "score"; subject: string; levels: string[]; failBelow?: string }
);

/** One field of a judgement rule; `failBelow: null` means it never fails. */
export type JudgementPatch = { claim: string } | { subject: string } | { levels: string[] } | { failBelow: string | null };

/** The verdict's handoff label as the Labels card shows it; null when the verdict does not label itself. */
export type HandoffLabel = { name: string; problem: string | null } | null;

export type PolicyView = {
  /** The steps people edit; a verdict's handoff labels belong to the Labels card. */
  steps: Record<VerdictWord, StepRow[]>;
  rules: JudgementRule[];
  labels: Record<VerdictWord, HandoffLabel>;
  addStep: (verdict: VerdictWord) => void;
  setStep: (verdict: VerdictWord, id: string, step: Step) => void;
  removeStep: (verdict: VerdictWord, id: string) => void;
  /** Adds the handoff labels to every verdict that lacks them, or removes them from every verdict. */
  setHandoffLabels: (on: boolean) => void;
  setLabelName: (verdict: VerdictWord, name: string) => void;
  /** Adds an empty rule and returns its id. */
  addRule: (shape: JudgementRule["shape"]) => string;
  patchRule: (id: string, patch: JudgementPatch) => void;
};

/** The names a new verdict label starts with. */
export const LABEL_NAMES: Record<VerdictWord, string> = { pass: "Triage: Ready", fail: "Triage: Not Ready", unsure: "Triage: Needs Human Review" };

const RULES_LABELS: Step = { do: "labels", target: { from: "rules" } };

/**
 * A verdict labels itself through a pair of steps for anyone: its own label, then the failed rules' labels. Until the
 * contract stores a name on the verdict label, a name other than the contract's is a fixed one-label list.
 */
function handoffPair(entries: StepEntry[]): { label: StepEntry; rules: StepEntry; name: string } | null {
  for (let i = 0; i + 1 < entries.length; i += 1) {
    const label = entries[i]!;
    const rules = entries[i + 1]!;
    if (!same(rules.step, RULES_LABELS) || label.step.do !== "labels" || label.step.for !== undefined) continue;
    const target = label.step.target;
    if (target.from === "list" && target.labels.length === 1) return { label, rules, name: target.labels[0]! };
    if (target.from === "verdict") return { label, rules, name: "" };
  }
  return null;
}

function labelStep(verdict: VerdictWord, name: string): Step {
  return name.trim() === verdictLabel(verdict) ? { do: "labels", target: { from: "verdict" } } : { do: "labels", target: { from: "list", labels: [name] } };
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
 * The repository's steps, judgement rules and handoff labels as the panel edits them. Steps are addressed by their
 * stable id and rules by theirs, so an edit lands on the row it was made on whatever moved around it.
 */
export function usePolicyView(draft: RepoDraft, edit: (update: DraftUpdate) => void): PolicyView {
  const repo = draft.pack.repo;

  function rows(verdict: VerdictWord): StepRow[] {
    const entries = stepEntries(draft, verdict);
    const pair = handoffPair(entries);
    const hidden = new Set(pair ? [pair.label.id, pair.rules.id] : []);
    function row(entry: StepEntry): StepRow[] {
      if (hidden.has(entry.id)) return [];
      const problem = stepProblem(draft, verdict, entry.step);
      return [{ id: entry.id, step: entry.step, problem: problem && (stepMissing(entry.step, repo) ?? problem.replace(/^\w+ step \d+ /, "")) }];
    }
    return entries.flatMap(row);
  }

  function label(verdict: VerdictWord): HandoffLabel {
    const pair = handoffPair(stepEntries(draft, verdict));
    if (!pair) return null;
    const name = pair.label.step.do === "labels" && pair.label.step.target.from === "verdict" ? verdictLabel(verdict) : pair.name;
    return { name, problem: name.trim() ? null : "name the label." };
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

  function setHandoffLabels(on: boolean) {
    for (const verdict of VERDICTS) {
      editSteps(verdict, function handoff(entries) {
        const pair = handoffPair(entries);
        if (!on) return pair ? entries.filter((entry) => entry.id !== pair.label.id && entry.id !== pair.rules.id) : entries;
        if (pair) return entries;
        return [...entries, { id: freshStepId(), step: labelStep(verdict, LABEL_NAMES[verdict]) }, { id: freshStepId(), step: RULES_LABELS }];
      });
    }
  }

  function setLabelName(verdict: VerdictWord, name: string) {
    editSteps(verdict, function named(entries) {
      const pair = handoffPair(entries);
      return pair ? entries.map((entry) => (entry.id === pair.label.id ? { id: entry.id, step: labelStep(verdict, name) } : entry)) : entries;
    });
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
  const labels = Object.fromEntries(VERDICTS.map((verdict) => [verdict, label(verdict)])) as Record<VerdictWord, HandoffLabel>;
  return { steps, rules: draft.pack.custom.flatMap(judgementRow), labels, addStep, setStep, removeStep, setHandoffLabels, setLabelName, addRule, patchRule };
}
