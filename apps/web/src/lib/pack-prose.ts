import {
  BUILT_IN_CHECK_NAMES,
  CHECK_CATALOG,
  checkName,
  isCatalogId,
  type StepKind,
  type CheckPack,
} from "@corbits/triage-contracts";

export const DO_NAMES: Record<StepKind, string> = {
  labels: "Add labels",
  assign: "Assign",
  "request-review": "Request review",
  comment: "Comment",
  approve: "Approve",
  "request-changes": "Request changes",
  close: "Close",
  merge: "Merge",
  nothing: "Do nothing",
};

export function checkLabel(pack: CheckPack | null, id: string): string | null {
  if (pack) return checkName(pack, id);
  const builtIn = BUILT_IN_CHECK_NAMES.get(id);
  if (builtIn !== undefined) return builtIn;
  return isCatalogId(id) ? CHECK_CATALOG[id].name : null;
}
