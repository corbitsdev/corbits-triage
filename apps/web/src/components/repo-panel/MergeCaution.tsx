import type { MergeRisk, RepoSource } from "@corbits/triage-contracts";

const RISK_NAMES: Record<MergeRisk, string> = { "first-timers": "pull requests from first-time contributors", "ci-config": "changes to CI workflows" };

/** What Triage approving or merging on its own can let in; the risks name GitHub's author associations and workflow paths. */
export function MergeCaution({ source, risks }: { source: RepoSource; risks: readonly MergeRisk[] }) {
  if (source !== "github" || risks.length === 0) return null;
  return <div className="sentence"><span className="txt">Triage approves or merges on its own, which can let unintended code in: {risks.map((risk) => RISK_NAMES[risk]).join(", ")}.</span></div>;
}
