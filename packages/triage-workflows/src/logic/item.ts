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
  /**
   * A preview, or a manager holding its judge until the host's checks finish, does not run the judge: the checks it would
   * answer wait on it, and the head waits for those checks or a human decides.
   */
  judgeSkipped?: true;
  judged?: Judged;
  automatic?: ActionKind[];
  pack?: CheckPack;
  source?: PolicySource;
  /** Where the pull request lives; absent on GitHub. */
  repoSource?: RepoSource;
  /** The hub waits no longer for the host's checks. */
  noWait?: true;
  /** The policy turns a block on, so `decide` chooses the Dos once the blocks have run and the comment names none. */
  blocksOn?: true;
  /** The App's bot account on GitHub, whose comments and reviews are triage's own. */
  appLogin?: string;
  error?: string;
}

export const NO_FACTS: PrFacts = {
  repo: "", number: 0, title: "", author: "", tier: "external", headSha: "", state: "open", draft: false, mergeable: null,
  checks: "none", failingChecks: [], pendingChecks: [], cancelledChecks: [], reviewers: [], approvals: 0, changesRequested: [], triageRequested: false,
  reviewAnswered: false, reviewedBy: [], labels: [], assignees: [], changedFiles: 0, additions: 0, deletions: 0, paths: [], files: [],
  body: "", rawBody: "", commits: [], commitMessages: [], docs: {}, rules: {}, branch: "", authorTeams: [], authorTeamsUnknown: [], events: [], hidden: [],
};

/** The head of a pull request that could not be read, when the host or the mail named one. */
export type UnreadPull = Pick<PrFacts, "repo" | "number" | "headSha">;

export function degradedItem({ error, pull, pack, automatic, repoSource, appLogin }: { error: string; pull?: UnreadPull; pack?: CheckPack; automatic?: ActionKind[]; repoSource?: RepoSource; appLogin?: string }): Item {
  return {
    facts: { ...NO_FACTS, ...pull },
    det: { state: "stale-unknown", reason: error, findings: [], checks: [], needsJudgment: false },
    error,
    ...(pack && { pack }),
    ...(automatic && { automatic }),
    ...(repoSource && { repoSource }),
    ...(appLogin && { appLogin }),
  };
}
