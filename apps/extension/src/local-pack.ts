import { defaultActions, recommendedPack, type CheckPack } from "@corbits/triage-contracts";

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
