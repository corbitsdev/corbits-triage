import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { ACTION_KINDS, PolicySourceShape, REPO_SOURCES, type ActionKind, type CheckPack, type PolicySource, type RepoSource } from "@corbits/triage-contracts";
import { deriveState, type PrFacts } from "../logic/checks.js";
import { degradedItem, type Item, type Judged, type UnreadPull } from "../logic/item.js";
import { judgeKey, prepareQualityEvaluation, type JudgeRequest } from "../logic/quality.js";
import { choiceFirst, choiceOf, repliesTo } from "./evaluate.js";
import { stepJson } from "../logic/step-json.js";

export type RulesItem = { error: string; pull?: UnreadPull; pack?: CheckPack; automatic?: ActionKind[]; repoSource?: RepoSource } | { facts: PrFacts; pack: CheckPack; automatic?: ActionKind[]; judged?: Judged; source?: PolicySource; repoSource?: RepoSource; noWait?: true; blocksOn?: true };

interface RulesInput {
  items: RulesItem[];
  batch: boolean;
}

export type JudgeChunk = Pick<JudgeRequest, "state" | "questions"> & { item: number };

export interface RulesOutput {
  items: Item[];
  batch: boolean;
  /** The judge's calls, in item order; recorded here so a re-run asks exactly the same. */
  chunks: JudgeChunk[];
  needsJudgment: boolean;
}

const Input = type({
  items: type({ error: "string", "pull?": { repo: "string", number: "number", headSha: "string" }, "pack?": "object", "automatic?": type.enumerated(...ACTION_KINDS).array(), "repoSource?": type.enumerated(...REPO_SOURCES) })
    .or({ facts: "object", pack: "object", "automatic?": type.enumerated(...ACTION_KINDS).array(), "judged?": "Record<string, string>", "source?": PolicySourceShape, "repoSource?": type.enumerated(...REPO_SOURCES), "noWait?": "true", "blocksOn?": "true" })
    .array(),
  batch: "boolean",
});

function ruled(it: RulesItem): { item: Item; requests: JudgeRequest[] } {
  if ("error" in it) return { item: degradedItem(it), requests: [] };
  const item = { facts: it.facts, det: deriveState(it.facts, undefined, it.pack), automatic: it.automatic, pack: it.pack, judged: it.judged, source: it.source, ...(it.repoSource && { repoSource: it.repoSource }), ...(it.noWait && { noWait: it.noWait }), ...(it.blocksOn && { blocksOn: it.blocksOn }) };
  if (!item.det.needsJudgment) return { item, requests: [] };
  const evaluation = prepareQualityEvaluation(item.facts, item.det.sources);
  const { requests, judgeError } = evaluation;
  if (judgeError !== undefined) return { item: { ...item, judgeError, judgeLimitExceeded: true }, requests: [] };
  // With every judged rule answered already, the verdict question needs no second round.
  const choice = choiceFirst(item, evaluation) ? choiceOf(item, evaluation, repliesTo(item, requests, [])) : undefined;
  const asked = [...requests, ...(choice && "request" in choice ? [choice.request] : [])];
  return { item, requests: asked.filter((request) => it.judged?.[judgeKey(request)] === undefined) };
}

export async function rules(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<RulesOutput> {
  const parsed = Input(stepJson(input));
  if (parsed instanceof type.errors) throw new Error(`rules: invalid input: ${parsed.summary}`);
  const { items, batch } = parsed as RulesInput;
  const ruledItems = items.map(ruled);
  const chunks = ruledItems.flatMap(({ requests }, item) => requests.map(({ state, questions }) => ({ item, state, questions })));
  return { items: ruledItems.map(({ item }) => item), batch, chunks, needsJudgment: chunks.length > 0 };
}
