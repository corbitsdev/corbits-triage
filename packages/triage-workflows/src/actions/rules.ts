import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { CLEANUP_MODES, type CheckPack, type CleanupMode, type RepoRole } from "@corbits/triage-contracts";
import { deriveState, type PrFacts } from "../logic/checks.js";
import { degradedItem, type Item, type Judged } from "../logic/item.js";
import { judgeKey, prepareQualityEvaluation, type JudgeRequest } from "../logic/quality.js";
import { stepJson } from "../logic/step-json.js";

export type RulesItem = { error: string } | { facts: PrFacts; pack: CheckPack; roles?: Record<string, RepoRole>; cleanupMode?: CleanupMode; judged?: Judged };

interface RulesInput {
  items: RulesItem[];
  batch: boolean;
}

/** One System One call the judge makes about item `item`. */
export type JudgeChunk = Pick<JudgeRequest, "state" | "questions"> & { item: number };

export interface RulesOutput {
  items: Item[];
  batch: boolean;
  /** The judge's calls, in item order; recorded here so a re-run asks exactly the same. */
  chunks: JudgeChunk[];
  /** Whether there is any chunk; the workflow skips the judge otherwise. */
  needsJudgment: boolean;
}

const Input = type({
  items: type({ error: "string" })
    .or({ facts: "object", pack: "object", "roles?": "object", "cleanupMode?": type.enumerated(...CLEANUP_MODES), "judged?": "Record<string, string>" })
    .array(),
  batch: "boolean",
});

function ruled(it: RulesItem): { item: Item; requests: JudgeRequest[] } {
  if ("error" in it) return { item: degradedItem(it.error), requests: [] };
  const item = { facts: it.facts, det: deriveState(it.facts, undefined, it.pack, it.roles ?? {}), cleanupMode: it.cleanupMode, pack: it.pack, roles: it.roles, judged: it.judged };
  if (!item.det.needsJudgment) return { item, requests: [] };
  const { requests, judgeError } = prepareQualityEvaluation(item.facts, item.det.sources);
  if (judgeError !== undefined) return { item: { ...item, judgeError, judgeLimitExceeded: true }, requests: [] };
  return { item, requests: requests.filter((request) => it.judged?.[judgeKey(request)] === undefined) };
}

export async function rules(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<RulesOutput> {
  const parsed = Input(stepJson(input));
  if (parsed instanceof type.errors) throw new Error(`rules: invalid input: ${parsed.summary}`);
  const { items, batch } = parsed as RulesInput;
  const ruledItems = items.map(ruled);
  const chunks = ruledItems.flatMap(({ requests }, item) => requests.map(({ state, questions }) => ({ item, state, questions })));
  return { items: ruledItems.map(({ item }) => item), batch, chunks, needsJudgment: chunks.length > 0 };
}
