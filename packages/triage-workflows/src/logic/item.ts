import type { CheckPack, CleanupMode } from "@corbits/triage-contracts";
import type { DeterministicResult, PrFacts } from "./checks.js";

export interface Item {
  facts: PrFacts;
  det: DeterministicResult;
  judge?: string;
  judgeError?: string;
  cleanupMode?: CleanupMode;
  pack?: CheckPack;
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
