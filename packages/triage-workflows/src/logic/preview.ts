import { VERDICTS, type VerdictWord } from "@corbits/triage-contracts";
import { evaluateActions, wakes, type ActionInput, type SuggestedAction } from "./actions.js";

export type ListPreview = { verdict: VerdictWord; dos: SuggestedAction[] };

export type ActionsPreview = { status: "not-woken" } | ({ status: "decided" } & ListPreview) | { status: "waits-on-judge"; lists: ListPreview[] };

/** The policy's actions on this head: the Dos the verdict decided, or every list the judge's verdict could run while it waits on the judge. */
export function previewActions(input: ActionInput, decided: SuggestedAction[] | "waits-on-judge"): ActionsPreview {
  if (!wakes(input.pack, input.facts)) return { status: "not-woken" };
  if (decided !== "waits-on-judge") return { status: "decided", verdict: input.verdict, dos: decided };
  return { status: "waits-on-judge", lists: VERDICTS.map((verdict) => ({ verdict, dos: evaluateActions({ ...input, verdict }) })) };
}
