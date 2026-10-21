import type { PostedCodeReview } from "@corbits/github-reads";
import type { FileNote } from "./notes.ts";
import type { PrRef } from "./pr.ts";

/** `waiting` is a rule GitHub cannot settle yet, such as CI still running; `not-run` a model check, which is not run here. */
export type RuleState = "pass" | "fail" | "waiting" | "not-run";

export type ViewRule = { check: string; name: string; kind: "machine" | "model"; state: RuleState; reason: string; evidence: string[] };

export type TriageView = {
  pr: PrRef;
  headSha: string;
  ranAt: string;
  /** The policy file's address, or null when the repository has none. */
  policy: { path: string; url: string } | null;
  /** The policy's pause label, when the pull request carries it and so is not checked. */
  paused?: string;
  rules: ViewRule[];
  notes: FileNote[];
  /** The newest code review the App sent to the pull request, read from GitHub, or why it could not be read. */
  codeReview: { review: PostedCodeReview | null } | { error: string };
};

/** The checks that ran here and how many of them passed. */
export function scoreOf(view: TriageView): { passed: number; run: number } {
  const run = view.rules.filter((rule) => rule.kind === "machine");
  return { passed: run.filter((rule) => rule.state === "pass").length, run: run.length };
}

/** A pull request opened again within this long reuses its last run. */
export const FRESH_MS = 10 * 60 * 1000;
