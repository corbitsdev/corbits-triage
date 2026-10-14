import { defaultActions, recommendedPack, type CheckPack } from "@corbits/triage-contracts";

/** The rules local mode runs before anyone changes them: what GitHub data alone can prove, plus the model checks a key answers. */
export function defaultLocalPack(repo: string): CheckPack {
  const base = recommendedPack(repo);
  return {
    ...base,
    checks: {
      ...base.checks,
      docs: { enabled: false },
      "no-forbidden-paths": { ...base.checks["no-forbidden-paths"], enabled: false },
    },
    actions: { ...defaultActions(), fail: [{ do: "labels", target: { from: "list", labels: ["triage:needs-author-update"] } }] },
  };
}
