import { Badge, type BadgeTone } from "@corbits/react-ui";
import type { MergeVerdict } from "../lib/hub-api.ts";
import { MERGE_LABEL, MERGE_SHORT_LABEL, mergeText, NOT_EVALUATED } from "../lib/triage-view.ts";

const MERGE_TONE: Record<MergeVerdict["verdict"], BadgeTone> = { ready: "success", "not-recommended": "danger" };

type MergeChipProps = { merge: MergeVerdict | null; compact?: boolean; className?: string };

/** Green when the pull request should merge now, red when not; the full line is its tooltip. */
export function MergeChip({ merge, compact = false, className }: MergeChipProps) {
  if (merge === null) return <Badge tone="neutral" className={className} title={NOT_EVALUATED}>{NOT_EVALUATED}</Badge>;
  const label = compact ? MERGE_SHORT_LABEL : MERGE_LABEL;
  return <Badge tone={MERGE_TONE[merge.verdict]} className={className} title={mergeText({ merge })}>{label[merge.verdict]}</Badge>;
}
