import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { CLEANUP_MODES, type CheckPack, type CleanupMode } from "@corbits/triage-contracts";
import { deriveState, type PrFacts } from "../logic/checks.js";
import { degradedItem, type Item } from "../logic/item.js";

type RulesItem = { error: string } | { facts: PrFacts; pack: CheckPack; cleanupMode?: CleanupMode };

interface RulesInput {
  items: RulesItem[];
}

export interface RulesOutput {
  items: Item[];
}

const Input = type({
  items: type({ error: "string" })
    .or({ facts: "object", pack: "object", "cleanupMode?": type.enumerated(...CLEANUP_MODES) })
    .array(),
});

function ruled(it: RulesItem): Item {
  if ("error" in it) return degradedItem(it.error);
  return { facts: it.facts, det: deriveState(it.facts, undefined, it.pack), cleanupMode: it.cleanupMode, pack: it.pack };
}

export async function rules(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<RulesOutput> {
  const parsed = Input(input);
  if (parsed instanceof type.errors) throw new Error(`rules: invalid input: ${parsed.summary}`);
  return { items: (parsed as RulesInput).items.map(ruled) };
}
