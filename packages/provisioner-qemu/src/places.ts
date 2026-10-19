import type { PlaceGuide } from "@corbits/triage-contracts";

export const QEMU_PLACE = {
  id: "qemu",
  label: "QEMU microVMs",
  why: "For a Triage server that can't run Docker, with a Linux server of your own that has KVM: each review runs in a virtual machine of its own there.",
  env: ["QEMU_PROVISIONER_URL=https://qemu.example.com", "QEMU_PROVISIONER_TOKEN=your_agent_token"],
  guide: "qemu.md",
} satisfies PlaceGuide;
