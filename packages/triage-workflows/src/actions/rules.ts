import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { ACTION_KINDS, PolicySourceShape, REPO_SOURCES, type ActionKind, type CheckPack, type PolicySource, type RepoSource } from "@corbits/triage-contracts";
import { deriveState, type PrFacts } from "../logic/checks.js";
import { degradedItem, type Item, type UnreadPull } from "../logic/item.js";
import { prepareQualityEvaluation, type JudgeRequest } from "../logic/quality.js";
import { choiceFirst, choiceOf } from "./evaluate.js";
import { stepJson } from "../logic/step-json.js";

export type RulesItem = { error: string; pull?: UnreadPull; pack?: CheckPack; automatic: ActionKind[]; repoSource?: RepoSource; appLogin?: string } | { facts: PrFacts; pack: CheckPack; automatic: ActionKind[]; source?: PolicySource; repoSource?: RepoSource; noWait?: true; blocksOn?: true; appLogin?: string };

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
  items: type({ error: "string", "pull?": { repo: "string", number: "number", headSha: "string" }, "pack?": "object", automatic: type.enumerated(...ACTION_KINDS).array(), "repoSource?": type.enumerated(...REPO_SOURCES), "appLogin?": "string" })
    .or({ facts: "object", pack: "object", automatic: type.enumerated(...ACTION_KINDS).array(), "source?": PolicySourceShape, "repoSource?": type.enumerated(...REPO_SOURCES), "noWait?": "true", "blocksOn?": "true", "appLogin?": "string" })
    .array(),
  batch: "boolean",
});

function ruled(it: RulesItem): { item: Item; requests: JudgeRequest[] } {
  if ("error" in it) return { item: degradedItem(it), requests: [] };
  // Absent optionals stay off the object: an effect key is canonical JSON, which has no undefined.
  const item = {
    facts: it.facts, det: deriveState(it.facts, undefined, it.pack), pack: it.pack, automatic: it.automatic,
    ...(it.source !== undefined && { source: it.source }), ...(it.repoSource && { repoSource: it.repoSource }), ...(it.noWait && { noWait: it.noWait }), ...(it.blocksOn && { blocksOn: it.blocksOn }), ...(it.appLogin && { appLogin: it.appLogin }),
  };
  if (!item.det.needsJudgment) return { item, requests: [] };
  const evaluation = prepareQualityEvaluation(item.facts, item.det.sources);
  const { requests, judgeError } = evaluation;
  if (judgeError !== undefined) return { item: { ...item, judgeError, judgeLimitExceeded: true }, requests: [] };
  // With no judged rule to ask first, the verdict question needs no second round.
  const choice = choiceFirst(evaluation) ? choiceOf(item, evaluation, []) : undefined;
  return { item, requests: [...requests, ...(choice && "request" in choice ? [choice.request] : [])] };
}

export async function rules(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<RulesOutput> {
  const parsed = Input(stepJson(input));
  if (parsed instanceof type.errors) throw new Error(`rules: invalid input: ${parsed.summary}`);
  const { items, batch } = parsed as RulesInput;
  const ruledItems = items.map(ruled);
  const chunks = ruledItems.flatMap(({ requests }, item) => requests.map(({ state, questions }) => ({ item, state, questions })));
  return { items: ruledItems.map(({ item }) => item), batch, chunks, needsJudgment: chunks.length > 0 };
}
