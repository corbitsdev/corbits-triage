import type { CheckPack } from "@corbits/triage-contracts";
import type { CheckResult } from "./hub-api.ts";

const COUNT = new Intl.NumberFormat("en-US");

/** The number a check is held to, read from the repository's pack as pr-triage reads it; null for a check without one. */
export function checkLimitText(pack: CheckPack | null, check: Pick<CheckResult, "check" | "output">): string | null {
  if (check.output?.kind === "score") return `needs ${Math.round(check.output.passAt)}`;
  if (pack === null) return null;
  switch (check.check) {
    case "max-files-changed": {
      const maxFiles = pack.checks["max-files-changed"]?.maxFiles;
      return maxFiles === undefined ? null : `limit ${COUNT.format(maxFiles)} files`;
    }
    case "max-lines-changed": {
      const maxLines = pack.checks["max-lines-changed"]?.maxLines;
      return maxLines === undefined ? null : `limit ${COUNT.format(maxLines)} lines`;
    }
  }
  const custom = pack.custom.find((row) => row.id === check.check);
  return custom?.kind === "rule" && custom.rule === "min-approvals" ? `needs ${custom.count} approvals` : null;
}
