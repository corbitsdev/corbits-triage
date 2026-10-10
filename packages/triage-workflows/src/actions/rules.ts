import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { CLEANUP_MODES, type CheckPack, type CleanupMode, type RepoRole } from "@corbits/triage-contracts";
import { deriveState, type PrFacts } from "../logic/checks.js";
import { degradedItem, type Item } from "../logic/item.js";
import { stepJson } from "../logic/step-json.js";

export type RulesItem = { error: string } | { facts: PrFacts; pack: CheckPack; roles?: Record<string, RepoRole>; cleanupMode?: CleanupMode };

interface RulesInput {
  items: RulesItem[];
  batch: boolean;
}

export interface RulesOutput {
  items: Item[];
  batch: boolean;
  /** Whether any item has a decision-model check to ask; the workflow skips the judge otherwise. */
  needsJudgment: boolean;
}

const Input = type({
  items: type({ error: "string" })
    .or({ facts: "object", pack: "object", "roles?": "object", "cleanupMode?": type.enumerated(...CLEANUP_MODES) })
    .array(),
  batch: "boolean",
});

function ruled(it: RulesItem): Item {
  if ("error" in it) return degradedItem(it.error);
  return { facts: it.facts, det: deriveState(it.facts, undefined, it.pack), cleanupMode: it.cleanupMode, pack: it.pack, roles: it.roles };
}

export async function rules(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<RulesOutput> {
  const parsed = Input(stepJson(input));
  if (parsed instanceof type.errors) throw new Error(`rules: invalid input: ${parsed.summary}`);
  const { items, batch } = parsed as RulesInput;
  const ruledItems = items.map(ruled);
  return { items: ruledItems, batch, needsJudgment: ruledItems.some((it) => it.det.needsJudgment) };
}
