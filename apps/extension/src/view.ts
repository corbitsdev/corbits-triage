import type { PostedCodeReview } from "@corbits/github-reads";
import type { VerdictWord } from "@corbits/triage-contracts";
import type { CheckResult } from "@corbits/triage-workflows/logic/checks";
import type { FileNote } from "./notes.ts";
import type { PrRef } from "./pr.ts";

export type ViewCheck = CheckResult & { name: string };

/** What the policy does on each verdict, as its steps in words. */
export type VerdictPlan = { verdict: VerdictWord; when: string; steps: string[] };

export type TriageView = {
  pr: PrRef;
  headSha: string;
  ranAt: string;
  /** The policy file's address, or null when the repository has none. */
  policy: { path: string; url: string } | null;
  /** The policy's pause label, when the pull request carries it and so is not checked. */
  paused?: string;
  checks: ViewCheck[];
  notes: FileNote[];
  plans: VerdictPlan[];
  /** The newest code review the App sent to the pull request, read from GitHub, or why it could not be read. */
  codeReview: { review: PostedCodeReview | null } | { error: string };
};

/** A pull request opened again within this long reuses its last run. */
export const FRESH_MS = 10 * 60 * 1000;

const READINESS: Record<ViewCheck["result"], number> = { pass: 1, unconfirmed: 0.5, fail: 0 };

/** The hub's readiness over the checks run here: pass counts 1, unconfirmed half and fail 0; null with none. */
export function readinessOf(view: TriageView): number | null {
  if (!view.checks.length) return null;
  return Math.round((view.checks.reduce((sum, check) => sum + READINESS[check.result], 0) / view.checks.length) * 100);
}

export type Tone = "ready" | "waiting" | "attention" | "unknown";

/** Strictly from the checks run here: any failed is Fail, all passed is Pass, and one not settled yet (CI) is running. */
export type Outcome = "pass" | "fail" | "running" | "none";

export function outcomeOf(checks: readonly ViewCheck[]): Outcome {
  if (!checks.length) return "none";
  if (checks.some((check) => check.result === "fail")) return "fail";
  return checks.some((check) => check.result === "unconfirmed") ? "running" : "pass";
}

const OUTCOME_NAMES: Record<Outcome, string> = { pass: "Pass", fail: "Fail", running: "Checks running", none: "Not checked" };
const TONES: Record<Outcome, Tone> = { pass: "ready", fail: "attention", running: "waiting", none: "unknown" };

export function stateName(view: TriageView): string {
  if (!view.policy) return "No policy";
  if (view.paused !== undefined) return "Paused";
  return OUTCOME_NAMES[outcomeOf(view.checks)];
}

export function toneOf(view: TriageView): Tone {
  return TONES[outcomeOf(view.checks)];
}

function countOf(checks: readonly ViewCheck[], result: ViewCheck["result"]): number {
  return checks.filter((check) => check.result === result).length;
}

export function nextStep(view: TriageView): string {
  if (!view.policy) return "This repository has no policy file, so there is nothing to check.";
  if (view.paused !== undefined) return `This pull request has the ${view.paused} label, so Triage leaves it alone.`;
  const { checks } = view;
  switch (outcomeOf(checks)) {
    case "pass":
      return `All ${checks.length} checks passed`;
    case "fail":
      return `${countOf(checks, "fail")} of ${checks.length} checks failed`;
    case "running":
      return `${countOf(checks, "unconfirmed")} of ${checks.length} checks still running`;
    case "none":
      return "There is nothing to check on this pull request.";
  }
}
