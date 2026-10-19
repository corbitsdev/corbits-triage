import type { PlaceGuide } from "@corbits/triage-contracts";

export const E2B_PLACE = {
  id: "e2b",
  label: "E2B sandboxes",
  why: "For a Triage server that can't run Docker, without a server of your own: each review runs in a sandbox in E2B's cloud, billed by E2B.",
  env: ["E2B_API_KEY=e2b_your_key"],
  guide: "e2b.md",
} satisfies PlaceGuide;
