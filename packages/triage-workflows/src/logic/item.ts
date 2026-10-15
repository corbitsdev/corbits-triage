import type { ActionKind, CheckPack, PolicySource, RepoSource } from "@corbits/triage-contracts";
import type { DeterministicResult, PrFacts } from "./checks.js";

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
  judged?: Judged;
  automatic?: ActionKind[];
  pack?: CheckPack;
  source?: PolicySource;
  /** Where the pull request lives; absent on GitHub. */
  repoSource?: RepoSource;
  error?: string;
}

export const NO_FACTS: PrFacts = {
  repo: "", number: 0, title: "", author: "", tier: "external", headSha: "", state: "open", draft: false, mergeable: null,
  checks: "none", failingChecks: [], pendingChecks: [], reviewers: [], approvals: 0, changesRequested: [], triageRequested: false,
  reviewAnswered: false, reviewedBy: [], labels: [], assignees: [], changedFiles: 0, additions: 0, deletions: 0, paths: [], files: [],
  body: "", commits: [], commitMessages: [], docs: {}, rules: {}, branch: "", authorTeams: [], authorTeamsUnknown: [], events: [],
};

export function degradedItem(reason: string): Item {
  return {
    facts: NO_FACTS,
    det: { state: "stale-unknown", reason, findings: [], checks: [], needsJudgment: false },
    error: reason,
  };
}
