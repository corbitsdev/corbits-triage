import type { VerdictWord } from "@corbits/triage-contracts";
import type { RateLimit } from "./github-api.ts";
import type { FileNote } from "./notes.ts";
import type { PolicyOrigin } from "./policy-source.ts";
import type { PrRef } from "./pr.ts";

/** `waiting` is a rule GitHub cannot settle yet, such as CI still running; `not-evaluated` a decision-model rule with no model to ask. */
export type RuleState = "pass" | "fail" | "waiting" | "not-evaluated";

export type ViewRule = { check: string; name: string; kind: "machine" | "model"; state: RuleState; reason: string; evidence: string[] };

/** What the hub would post for the verdict: its labels, its comment, and the policy's other steps in words. */
export type Posted = { labels: string[]; comment: string; steps: string[] };

export type TriageView = {
  pr: PrRef;
  title: string;
  headSha: string;
  ranAt: string;
  policy: PolicyOrigin;
  /** Whether a decision model was set, so its rules were asked. */
  modelAsked: boolean;
  rules: ViewRule[];
  /** Named only when the rules decide it without the decision model. */
  decided: ({ verdict: VerdictWord } & Posted) | null;
  notes: FileNote[];
  rate?: RateLimit;
};

/** A pull request opened again within this long reuses its last run. */
export const FRESH_MS = 10 * 60 * 1000;
