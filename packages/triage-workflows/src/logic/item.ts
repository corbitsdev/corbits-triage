import type { CheckPack, CleanupMode, RepoRole } from "@corbits/triage-contracts";
import type { DeterministicResult, PrFacts } from "./checks.js";

export interface Item {
  facts: PrFacts;
  det: DeterministicResult;
  judge?: string;
  judgeError?: string;
  /** The quality evaluation exceeds the System One budget, so the judge is not asked and a human decides. */
  judgeLimitExceeded?: true;
  /** A preview does not run the judge, so the checks it would answer wait on it and a human decides. */
  judgeSkipped?: true;
  cleanupMode?: CleanupMode;
  pack?: CheckPack;
  roles?: Record<string, RepoRole>;
  /** Why no facts were gathered; the verdict is then degraded with this reason. */
  error?: string;
}

const NO_FACTS: PrFacts = {
  repo: "", number: 0, title: "", author: "", tier: "external", headSha: "", state: "open", draft: false, mergeable: null,
  baseBehindBy: 0, checks: "none", requestedReviewers: 0, approvals: 0, openPrs: [],
};

export function degradedItem(reason: string): Item {
  return {
    facts: NO_FACTS,
    det: { state: "stale-unknown", reason, findings: [], checks: [], duplicateOf: null, needsJudgment: false },
    error: reason,
  };
}

/** Whether the judge asks about this item; an item over the evaluation budget is left to a human instead. */
export function asksJudge(it: Item): boolean {
  return it.det?.needsJudgment === true && it.judgeLimitExceeded !== true;
}
