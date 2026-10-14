import { Badge, type BadgeTone } from "@corbits/react-ui";
import type { VerdictWord } from "@corbits/triage-contracts";
import type { PrItem } from "../lib/hub-api.ts";
import { NOT_EVALUATED, VERDICT_LABEL, verdictText } from "../lib/triage-view.ts";

const VERDICT_TONE: Record<VerdictWord, BadgeTone> = { pass: "success", fail: "danger", unsure: "neutral" };

type VerdictChipProps = { item: Pick<PrItem, "verdict" | "score" | "reasons">; className?: string };

export function VerdictChip({ item, className }: VerdictChipProps) {
  if (item.verdict === null) return <Badge tone="neutral" className={className} title={NOT_EVALUATED}>{NOT_EVALUATED}</Badge>;
  return <Badge tone={VERDICT_TONE[item.verdict]} className={className} title={verdictText(item)}>{VERDICT_LABEL[item.verdict]}</Badge>;
}
