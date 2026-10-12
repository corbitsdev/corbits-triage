import { RECOMMENDED_DRIFT, type CheckPack } from "@corbits/triage-contracts";
import type { CheckResult } from "./hub-api.ts";

const COUNT = new Intl.NumberFormat("en-US");

/** The number a check is held to, read from the repository's pack as pr-triage reads it; null for a check without one. */
export function checkLimitText(pack: CheckPack | null, check: Pick<CheckResult, "check" | "output">): string | null {
  if (check.output?.kind === "score") return `needs ${Math.round(check.output.passAt)}`;
  if (pack === null) return null;
  switch (check.check) {
    case "size": {
      const { maxFiles, maxLines } = pack.checks.size ?? {};
      const limits = [
        ...(maxFiles === undefined ? [] : [`${COUNT.format(maxFiles)} files`]),
        ...(maxLines === undefined ? [] : [`${COUNT.format(maxLines)} lines`]),
      ];
      return limits.length === 0 ? null : `limit ${limits.join(" / ")}`;
    }
    case "drift": return `limit ${COUNT.format(pack.checks.drift?.maxBehindBy ?? RECOMMENDED_DRIFT.maxBehindBy)} commits behind`;
    case "reviewers": return "needs 1 reviewer";
  }
  const custom = pack.custom.find((row) => row.id === check.check);
  return custom?.kind === "rule" && custom.rule === "min-approvals" ? `needs ${custom.count} approvals` : null;
}
