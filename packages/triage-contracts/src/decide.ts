import type { PolicyEvent, VerdictWord } from "./check-pack.js";
import { BLOCK_KINDS, kindsOf, SEVERITIES, type BlockKind, type DecideRule } from "./policy-workflow.js";

/** A block's outcome; `worst` is its most severe counted finding. */
export type BlockResult = { outcome: "clean" | "incomplete" | "skipped" } | { outcome: "findings"; worst: (typeof SEVERITIES)[number] };

type BlockCondition = NonNullable<DecideRule["if"][BlockKind]>;

/**
 * `events` lists what woke the run, `on` the blocks the policy turns on, `outcomes` those the run produced, and
 * `author` the groups the author is in, undefined when that cannot be told.
 */
export type DecideInput = {
  triage: VerdictWord;
  events: readonly PolicyEvent[];
  on: readonly BlockKind[];
  outcomes: Readonly<Partial<Record<BlockKind, BlockResult>>>;
  author: readonly string[] | undefined;
};

/** `rule` is the index of the rule that matched. */
export type Decision = { do: DecideRule["do"]; rule: number } | { flag: string };

function conditionsOf(when: DecideRule["if"]): Array<[BlockKind, BlockCondition]> {
  return BLOCK_KINDS.flatMap((block): Array<[BlockKind, BlockCondition]> => (when[block] === undefined ? [] : [[block, when[block]]]));
}

function blockMatches(condition: BlockCondition, result: BlockResult): boolean {
  if (typeof condition === "string") return condition === result.outcome;
  if ("findings" in condition) return result.outcome === "findings" && SEVERITIES.indexOf(result.worst) >= SEVERITIES.indexOf(condition.findings);
  return condition.includes(result.outcome);
}

const INCOMPLETE: BlockResult = { outcome: "incomplete" };

/** A block that is on, or that a rule names, and that the run gave no outcome is incomplete. */
function outcomeOf(input: DecideInput, block: BlockKind): BlockResult {
  return input.outcomes[block] ?? INCOMPLETE;
}

/** Every block that is on, that a rule names or that has an outcome, and was not skipped. */
function ran(rules: readonly DecideRule[], input: DecideInput): BlockResult[] {
  const named = rules.flatMap((rule) => conditionsOf(rule.if).map(([block]) => block));
  const blocks = new Set([...input.on, ...named, ...BLOCK_KINDS.filter((block) => input.outcomes[block] !== undefined)]);
  return [...blocks].map((block) => outcomeOf(input, block)).filter((result) => result.outcome !== "skipped");
}

function ruleMatches(when: DecideRule["if"], input: DecideInput, results: readonly BlockResult[]): boolean {
  if (when.all === "clean" && !results.every((result) => result.outcome === "clean")) return false;
  if (when.triage !== undefined && !(typeof when.triage === "string" ? [when.triage] : when.triage).includes(input.triage)) return false;
  if (when.event && !when.event.some((event) => input.events.includes(event))) return false;
  if (when.author && !when.author.some((group) => input.author!.includes(group))) return false;
  return conditionsOf(when).every(([block, condition]) => blockMatches(condition, outcomeOf(input, block)));
}

/**
 * The first matching rule's actions; nothing matched, or a rule on groups when the author's cannot be read, flags for a
 * maintainer. Grants are applied elsewhere.
 */
export function decide(rules: readonly DecideRule[], input: DecideInput): Decision {
  if (input.author === undefined && rules.some((rule) => rule.if.author)) return { flag: "it is not known which groups the author is in" };
  const results = ran(rules, input);
  const at = rules.findIndex((rule) => ruleMatches(rule.if, input, results));
  if (at === -1) return { flag: "no rule matched" };
  const kinds = kindsOf(rules[at]!.do);
  const approving = kinds.includes("approve") || kinds.includes("merge");
  if (approving && results.some((result) => result.outcome === "incomplete")) return { flag: "a block is incomplete" };
  return { do: rules[at]!.do, rule: at };
}
