import type { PostedCodeReview } from "@corbits/github-reads";
import type { VerdictWord } from "@corbits/triage-contracts";
import type { FileNote } from "./notes.ts";
import type { PrRef } from "./pr.ts";

/** `waiting` is a rule GitHub cannot settle yet, such as CI still running; `not-evaluated` a decision-model rule, which is not run here. */
export type RuleState = "pass" | "fail" | "waiting" | "not-evaluated";

export type ViewRule = { check: string; name: string; kind: "machine" | "model"; state: RuleState; reason: string; evidence: string[] };

export type TriageView = {
  pr: PrRef;
  headSha: string;
  ranAt: string;
  /** The policy file's address, or null when the repository has none. */
  policy: { path: string; url: string } | null;
  rules: ViewRule[];
  /** Named only when the rules decide it without the decision model. */
  decided: { verdict: VerdictWord } | null;
  notes: FileNote[];
  /** The newest code review the App sent to the pull request, read from GitHub, or why it could not be read. */
  codeReview: { review: PostedCodeReview | null } | { error: string };
};

/** A pull request opened again within this long reuses its last run. */
export const FRESH_MS = 10 * 60 * 1000;
