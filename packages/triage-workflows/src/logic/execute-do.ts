import { AGENT_DO, DERIVED_LABELS_DO, type ResolvedTarget } from "@corbits/triage-contracts";

/** Why a Do can never run as the verdict recorded it, known without asking GitHub; a verdict recorded before agent Dos were removed may still name one. */
export function unrunnable(step: { kind: string; target: ResolvedTarget }): string | undefined {
  if (step.kind === "agent") return AGENT_DO;
  if (step.kind === "labels" && !("labels" in step.target)) return DERIVED_LABELS_DO;
  return undefined;
}
