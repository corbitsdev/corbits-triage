import type { QualityCheckId } from "@corbits/triage-contracts";
import type { DeterministicResult, PrFacts } from "./checks.js";

export interface QualityQuestion {
  id: string;
  type: "boolean";
  instructions: string;
}

/** Each question is answered true when the pull request passes the check. */
const INSTRUCTIONS: Record<QualityCheckId, string> = {
  focused: "Does this pull request make one focused change rather than mixing unrelated changes?",
  docs: "If this pull request changes user-facing behavior, configuration, or a public API, does it update the documentation? Answer true when no documentation change is needed.",
  tests: "If this pull request changes runtime behavior, does it add or update tests? Answer true when no test change is needed.",
};

const FAILURES: Record<QualityCheckId, string> = {
  focused: "mixes unrelated changes",
  docs: "documentation is not updated",
  tests: "tests are not added or updated",
};

const ACTIONS: Record<QualityCheckId, string> = {
  focused: "Split out unrelated changes",
  docs: "Update the documentation",
  tests: "Add or update tests",
};

const PASSES: Record<QualityCheckId, string> = {
  focused: "makes one focused change",
  docs: "documentation is up to date",
  tests: "tests cover the change",
};

const MAX_BODY = 4000;
const MAX_PATHS = 200;
const MAX_COMMITS = 50;

export function qualityQuestions(sources: NonNullable<DeterministicResult["sources"]>): QualityQuestion[] {
  return [
    ...sources.quality.map(({ id }) => ({ id, type: "boolean" as const, instructions: INSTRUCTIONS[id] })),
    ...sources.custom.map(({ name, instruction }, i) => ({
      id: `custom-${i + 1}`,
      type: "boolean" as const,
      instructions: `${name}: ${instruction} Answer true when the pull request meets this.`,
    })),
  ];
}

export function qualityState(facts: PrFacts) {
  return {
    title: facts.title,
    body: (facts.body ?? "").slice(0, MAX_BODY),
    commits: (facts.commits ?? []).slice(0, MAX_COMMITS),
    paths: (facts.paths ?? []).slice(0, MAX_PATHS),
    changedFiles: facts.changedFiles,
    additions: facts.additions,
    deletions: facts.deletions,
  };
}

export function failureText(id: string, sources: NonNullable<DeterministicResult["sources"]>): string {
  if (id in FAILURES) return FAILURES[id as QualityCheckId];
  const custom = sources.custom[Number(id.slice("custom-".length)) - 1];
  return custom ? `does not meet "${custom.name}"` : `does not pass ${id}`;
}

export function actionText(id: string, sources: NonNullable<DeterministicResult["sources"]>): string {
  if (id in ACTIONS) return ACTIONS[id as QualityCheckId];
  const custom = sources.custom[Number(id.slice("custom-".length)) - 1];
  return custom ? `Meet "${custom.name}"` : `Pass ${id}`;
}

export function passText(id: string, sources: NonNullable<DeterministicResult["sources"]>): string {
  if (id in PASSES) return PASSES[id as QualityCheckId];
  const custom = sources.custom[Number(id.slice("custom-".length)) - 1];
  return custom ? `meets "${custom.name}"` : `passes ${id}`;
}
