import type { PostedCodeReview } from "@corbits/github-reads";
import type { CheckResult } from "@corbits/triage-workflows/logic/checks";
import type { FileNote } from "./notes.ts";
import type { PrRef } from "./pr.ts";
import type { RunState } from "./storage.ts";

export type ViewCheck = CheckResult & { name: string };

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

/**
 * Strictly from the checks run here: any failed is Fail and all passed is Pass. Otherwise CI still running is running,
 * and anything else not settled yet, such as mergeability GitHub has not worked out, is unsettled; neither is a Pass.
 */
export type Outcome = "pass" | "fail" | "running" | "unsettled" | "none";

export function outcomeOf(checks: readonly ViewCheck[]): Outcome {
  if (!checks.length) return "none";
  if (checks.some((check) => check.result === "fail")) return "fail";
  const open = checks.filter((check) => check.result === "unconfirmed");
  if (!open.length) return "pass";
  return open.every((check) => check.check === "ci-green") ? "running" : "unsettled";
}

const OUTCOME_NAMES: Record<Outcome, string> = { pass: "Pass", fail: "Fail", running: "Checks running", unsettled: "Not settled", none: "Not checked" };
const TONES: Record<Outcome, Tone> = { pass: "ready", fail: "attention", running: "waiting", unsettled: "unknown", none: "unknown" };

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
      return "CI is still running";
    case "unsettled":
      return `${countOf(checks, "unconfirmed")} of ${checks.length} checks not settled yet`;
    case "none":
      return "There is nothing to check on this pull request.";
  }
}

/** The status beside the title. A run that failed leaves the head unchecked, so an older result is never shown as this one's. */
export function statusOf(view: TriageView | undefined, state: RunState | undefined): { text: string; tone: Tone | "busy" } {
  if (state?.running) return { text: "Triaging", tone: "busy" };
  if (state?.error) return { text: "Could not run", tone: "unknown" };
  if (!view) return { text: "Not triaged yet", tone: "unknown" };
  return { text: stateName(view), tone: toneOf(view) };
}
