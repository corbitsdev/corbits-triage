import { type } from "arktype";
import { isRecord } from "@corbits/common";
import { authorGroupsOf, BLOCK_KINDS, decide, POLICY_EVENTS, policyWorkflowSchema, SEVERITIES, triggerRequestOf, type BlockKind, type BlockResult, type Decision, type DecideRule, type PolicyEvent, type Step } from "@corbits/triage-contracts";
import { suggestedDos } from "@corbits/triage-workflows/actions/evaluate";
import type { SuggestedAction } from "@corbits/triage-workflows/logic/actions";
import type { Item } from "@corbits/triage-workflows/logic/item";
import type { Verdict } from "@corbits/triage-workflows/logic/render";
import { CODE_REVIEW, settled, verdictOutput, type Steps } from "./code-review.js";

/** The step that decides what execute runs. */
export const DECIDE = "decide";

/** The policy's `decide` rules and the blocks it turns on, which the hub sends beside the pack. */
const Trigger = policyWorkflowSchema.pick("decide").required().merge({ blocks: type.enumerated(...BLOCK_KINDS).array() }).onUndeclaredKey("ignore");

/** A worst finding that cannot be read is the most severe. */
function codeReviewResult(steps: Steps): BlockResult | undefined {
  const output = settled(steps, CODE_REVIEW);
  if (!isRecord(output)) return undefined;
  if (output.outcome === "findings") return { outcome: "findings", worst: SEVERITIES.find((severity) => severity === output.worst) ?? "critical" };
  if (output.outcome === "clean" || output.outcome === "incomplete" || output.outcome === "skipped") return { outcome: output.outcome };
  return undefined;
}

/** Catch-up runs the policy's actions whatever woke it. */
function eventsOf(item: Item): PolicyEvent[] {
  const events: readonly string[] = item.facts.events;
  return events.includes("catch-up") ? [...POLICY_EVENTS] : POLICY_EVENTS.filter((event) => events.includes(event));
}

function authorOf({ facts, pack }: Item): string[] | undefined {
  return authorGroupsOf(pack?.groups ?? {}, { login: facts.author, kind: facts.authorKind, teams: facts.authorTeams, teamsUnknown: facts.authorTeamsUnknown });
}

/** The pull request's triaged item, from whichever branch triage took. */
function itemOf(steps: Steps): Item | undefined {
  const rules = settled(steps, "rules");
  const items = isRecord(rules) && Array.isArray(rules.items) ? rules.items : [];
  return items.length === 1 && isRecord(items[0]) && isRecord(items[0].facts) ? (items[0] as unknown as Item) : undefined;
}

/** Only code review runs here: any other block the policy turns on has no outcome, which `decide` reads as incomplete. */
function decisionOf({ decide: rules, blocks }: typeof Trigger.infer, item: Item, verdict: Verdict, review: BlockResult | undefined): Decision {
  return decide(rules, { triage: verdict.verdict, events: eventsOf(item), on: blocks, outcomes: review === undefined ? {} : { "code-review": review }, author: authorOf(item) });
}

/** Why a Do of the verdict's own that `decide` left out waits: the first block that ran and was not clean. */
function notClean(blocks: readonly BlockKind[], review: BlockResult | undefined): string {
  if (review !== undefined && review.outcome !== "clean" && review.outcome !== "skipped") return `Code review is ${review.outcome}`;
  const other = blocks.find((block) => block !== "code-review");
  return other === undefined ? "The policy's decide did not choose it" : `The ${other} block is incomplete`;
}

function stepsOf(written: DecideRule["do"]): Step[] {
  return (Array.isArray(written) ? written : [written]).map((item) => (typeof item === "string" ? { do: item } : item) as Step);
}

function unattended(verdict: Verdict) {
  return function runs(action: SuggestedAction): action is Extract<SuggestedAction, { effectId: string }> {
    return "effectId" in action && action.held !== true && verdict.automatic.includes(action.kind);
  };
}

/**
 * The one decision of the run, and the Dos it makes: the matched rule's steps, held and granted as triage's own, beside
 * the labelling rules' labels, which run whatever is decided. Every other Do the verdict would have run unattended is
 * `held` for a maintainer with the reason, so one a schema 3 file's actions approve or merge with waits in Needs you. A
 * host action's input must be JSON, so execute reads this one output rather than the whole steps record.
 */
function decided(trigger: unknown, steps: Steps) {
  const verdict = verdictOutput(steps) as Verdict | undefined;
  const item = itemOf(steps);
  if (!isRecord(verdict) || !item) throw new Error("decide: triage gave no verdict");
  const parsed = Trigger(triggerRequestOf(trigger));
  const review = codeReviewResult(steps);
  const decision = parsed instanceof type.errors ? { flag: `the trigger's decide rules are invalid: ${parsed.summary}` } : decisionOf(parsed, item, verdict, review);
  const dos = suggestedDos(item, verdict, "flag" in decision ? [] : stepsOf(decision.do));
  const running = new Set(dos.flatMap((action) => ("effectId" in action ? [action.effectId] : [])));
  const blocks = parsed instanceof type.errors ? [] : parsed.blocks;
  const error = "flag" in decision ? `Flagged for a maintainer: ${decision.flag}.` : `${notClean(blocks, review)}; a maintainer decides.`;
  const held = verdict.actions.filter(unattended(verdict)).filter((action) => !running.has(action.effectId)).map((action) => ({ effectId: action.effectId, status: "held" as const, error }));
  return { decision, verdict: { ...verdict, actions: dos }, held };
}

/** The decide action: its input is every settled step's output beside the trigger as `payload`. */
export async function decideActions(input: unknown) {
  if (!isRecord(input)) throw new Error("decideActions: input is not an object");
  const { payload, ...steps } = input;
  return decided(payload, steps as Steps);
}
