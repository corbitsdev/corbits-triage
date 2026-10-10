import { Badge } from "@corbits/react-ui";
import type { Evaluation } from "../../lib/pack-prose.ts";

export default function EvalBadge({ evaluation }: { evaluation: Evaluation }) {
  return evaluation === "rule" ? <Badge tone="neutral">Rule</Badge> : <Badge tone="info">Decision model</Badge>;
}
