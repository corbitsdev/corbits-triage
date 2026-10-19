import type { PlaceGuide } from "@corbits/triage-contracts";

export const FLY_PLACE = {
  id: "fly",
  label: "Fly Machines",
  why: "For a Triage server without Docker and no machine of your own: each review runs in a microVM of its own on Fly.io, billed by Fly.",
  env: ["FLY_API_TOKEN=FlyV1 …", "FLY_APP=corbits-triage-sidecars", "FLY_REGION=iad"],
  guide: "fly.md",
} satisfies PlaceGuide;
