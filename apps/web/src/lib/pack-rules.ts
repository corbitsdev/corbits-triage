import { CATALOG_IDS, catalogCheckEnabled, classificationSources, customCheckEnabled, type CheckPack } from "@corbits/triage-contracts";

/** Whether a rule is switched on; triage runs without one, but triggers nothing. */
export function hasRuleOn(pack: CheckPack): boolean {
  return CATALOG_IDS.some((id) => catalogCheckEnabled(pack, id)) || pack.custom.some(customCheckEnabled);
}

/** A judgement rule asks the decision model: a quality rule, or a custom model rule, while it is on. */
export function policyNeedsModel(pack: CheckPack): boolean {
  const sources = classificationSources(pack);
  return sources.quality.length > 0 || sources.custom.length > 0;
}
