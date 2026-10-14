import { Badge } from "@corbits/react-ui";

/** Whether triage runs a Do on its own or it waits for a person in the inbox. */
export default function RunPill({ automatic }: { automatic: boolean }) {
  if (automatic) return <Badge tone="success" className="pill">automatic</Badge>;
  return <Badge tone="warning" className="pill">waits for you</Badge>;
}
