import { AGENT_DO, DERIVED_LABELS_DO } from "@corbits/triage-contracts";
import type { SuggestedDo } from "./actions.js";

/** Why a Do can never run as the verdict recorded it, known without asking GitHub. */
export function unrunnable(step: Pick<SuggestedDo, "kind" | "target">): string | undefined {
  if (step.kind === "agent") return AGENT_DO;
  if (step.kind === "labels" && !("labels" in step.target)) return DERIVED_LABELS_DO;
  return undefined;
}
