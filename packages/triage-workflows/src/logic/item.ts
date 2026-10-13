import type { ActionKind, CheckPack } from "@corbits/triage-contracts";
import type { DeterministicResult, PrFacts } from "./checks.js";

/** Judge answers by the `judgeKey` of the request each answered. */
export type Judged = Record<string, string>;

export interface Item {
  facts: PrFacts;
  det: DeterministicResult;
  judge?: string;
  judgeError?: string;
  /** The quality evaluation exceeds the System One budget, so the judge is not asked and a human decides. */
  judgeLimitExceeded?: true;
  /** A preview does not run the judge, so the checks it would answer wait on it and a human decides. */
  judgeSkipped?: true;
  /** Answers an earlier run of this head got, by `judgeKey`; their requests are not asked again. */
  judged?: Judged;
  /** The Do kinds the pr-triage role is granted on the repository, as the hub's mail said. */
  automatic?: ActionKind[];
  pack?: CheckPack;
  /** Why no facts were gathered; the verdict is then degraded with this reason. */
  error?: string;
}

const NO_FACTS: PrFacts = {
  repo: "", number: 0, title: "", author: "", tier: "external", headSha: "", state: "open", draft: false, mergeable: null,
  checks: "none", approvals: 0,
};

export function degradedItem(reason: string): Item {
  return {
    facts: NO_FACTS,
    det: { state: "stale-unknown", reason, findings: [], checks: [], needsJudgment: false },
    error: reason,
  };
}
