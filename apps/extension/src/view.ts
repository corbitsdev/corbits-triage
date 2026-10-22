import type { PostedCodeReview } from "@corbits/github-reads";
import type { VerdictWord } from "@corbits/triage-contracts";
import type { CheckResult } from "@corbits/triage-workflows/logic/checks";
import type { Verdict } from "@corbits/triage-workflows/logic/render";
import type { FileNote } from "./notes.ts";
import type { PrRef } from "./pr.ts";

export type ViewCheck = CheckResult & { name: string };

/** What the policy's verdict would do on this pull request: the labels and comment it posts and the actions it takes. */
export type ViewVerdict = Pick<Verdict, "verdict" | "state" | "reason" | "nextAction" | "labels"> & { comment: string; actions: string[] };

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
  /** Absent when the policy's judgement rules, which are not run here, could still change it. */
  verdict?: ViewVerdict;
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

const VERDICT_NAMES: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };
const TONES: Record<VerdictWord, Tone> = { pass: "ready", unsure: "waiting", fail: "attention" };

export function stateName(view: TriageView): string {
  if (!view.policy) return "No policy";
  if (view.paused !== undefined) return "Paused";
  if (view.verdict) return VERDICT_NAMES[view.verdict.verdict];
  const passed = view.checks.filter((check) => check.result === "pass").length;
  return passed === view.checks.length ? "Checks passed" : `${passed}/${view.checks.length} checks passed`;
}

export function toneOf(view: TriageView): Tone {
  return view.verdict ? TONES[view.verdict.verdict] : "unknown";
}

export function nextStep(view: TriageView): string {
  if (!view.policy) return "This repository has no policy file, so there is nothing to check.";
  if (view.paused !== undefined) return `This pull request has the ${view.paused} label, so Triage leaves it alone.`;
  return view.verdict?.nextAction ?? "Triage decides the verdict.";
}
