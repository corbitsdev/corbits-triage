import type { PlaceGuide } from "@corbits/triage-contracts";

export const RAILWAY_PLACE = {
  id: "railway-sandboxes",
  label: "Railway Sandboxes",
  why: "For a Triage server on Railway and no machine of your own: each review runs in a Railway sandbox, billed by Railway.",
  env: ["RAILWAY_SANDBOX_TOKEN=your_workspace_token", "RAILWAY_SANDBOX_ENVIRONMENT_ID=your_environment_id"],
  guide: "railway-sandboxes.md",
} satisfies PlaceGuide;
