import { Badge } from "@corbits/react-ui";

export default function RunPill({ automatic }: { automatic: boolean }) {
  if (automatic) return <Badge tone="success" className="pill">automatic</Badge>;
  return <Badge tone="warning" className="pill">waits for you</Badge>;
}
