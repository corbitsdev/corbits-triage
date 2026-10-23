// The policy file's v4 keys beside `rules`: author groups, one key per block that runs after triage, `pace`, `pauseLabel`
// and `decide`. They are read and validated here; nothing acts on them yet, except steps naming a group.
import { type } from "arktype";
import { AUTHOR_GROUPS, AUTHOR_KINDS, decideDoSchema, fileGroupSchema, Glob, GROUP_NAME_MAX, GroupName, Label, POLICY_EVENTS, VERDICTS, type AuthorKind, type AuthorMatch, type FileAuthorMatch, type PolicyActions, type Step, type VerdictWord } from "./check-pack.js";
import { RULE_GATES } from "./rules-gate.js";
import { EVERYONE } from "./step-when.js";

export const BLOCK_KINDS = ["code-review", "security", "deslop"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const PROVIDERS = ["anthropic", "openai", "xai", "google", "opencode", "custom"] as const;

/** Least severe first. */
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const BLOCK_OUTCOMES = ["clean", "findings", "incomplete", "skipped"] as const;

const LIST_MAX = 50;

const Verdicts = type.enumerated(...VERDICTS).or(type.enumerated(...VERDICTS).array().atLeastLength(1));
const GroupNames = GroupName.array().atLeastLength(1).atMostLength(LIST_MAX);
const Globs = Glob.array().atLeastLength(1).atMostLength(LIST_MAX);
const Severity = type.enumerated(...SEVERITIES);
const Duration = type(/^[1-9]\d*[smhd]$/);
const Count = type("number.integer").atLeast(1);

export const blockCleanSchema = type({ "+": "reject", "below?": Severity });

const BLOCK_WHEN = { "+": "reject", "triage?": Verdicts, "paths?": Globs } as const;

const BLOCK_PROPS = {
  "+": "reject",
  on: "boolean",
  "for?": GroupNames,
  "when?": BLOCK_WHEN,
  "clean?": blockCleanSchema,
  "provider?": type.enumerated(...PROVIDERS),
} as const;

const BlockSchema = type(BLOCK_PROPS);

/** Only code review runs today, so only it takes `when.rules`. */
const CodeReviewSchema = type({ ...BLOCK_PROPS, "when?": { ...BLOCK_WHEN, "rules?": type.enumerated(...RULE_GATES) } });

const PaceSchema = type({
  "+": "reject",
  "debounce?": Duration,
  "maxWait?": Duration,
  "perHead?": Count,
  "cap?": { "+": "reject", runs: Count, per: Duration },
  "backoff?": { "+": "reject", pushes: Count, within: Duration, pause: Duration },
});

const Outcome = type.enumerated(...BLOCK_OUTCOMES);
const BlockCondition = Outcome.or(Outcome.array().atLeastLength(1)).or({ "+": "reject", findings: Severity });

const DecideRuleSchema = type({
  "+": "reject",
  if: {
    "+": "reject",
    "all?": "'clean'",
    "triage?": Verdicts,
    "event?": type.enumerated(...POLICY_EVENTS).array().atLeastLength(1),
    "author?": GroupNames,
    "code-review?": BlockCondition,
    "security?": BlockCondition,
    "deslop?": BlockCondition,
  },
  do: decideDoSchema,
});

export const WORKFLOW_PROPS = {
  "groups?": type({ "[string]": fileGroupSchema }),
  "code-review?": CodeReviewSchema,
  "security?": BlockSchema,
  "deslop?": BlockSchema,
  "pace?": PaceSchema,
  "pauseLabel?": Label,
  "decide?": DecideRuleSchema.array(),
} as const;

export const WORKFLOW_KEYS = ["groups", ...BLOCK_KINDS, "pace", "pauseLabel", "decide"] as const;

export const policyWorkflowSchema = type({ "+": "reject", ...WORKFLOW_PROPS });
export type PolicyWorkflow = typeof policyWorkflowSchema.infer;
export type DecideRule = NonNullable<PolicyWorkflow["decide"]>[number];

/** Why a file is refused, and where: keys from its root. */
export type PathProblem = { message: string; path: readonly PropertyKey[] };

const NAME_MAX = 80;

/** A name from the file, cut short so a refusal never carries much of it. */
function shown(name: string): string {
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX)}…` : name;
}

/** A path as the file spells it: `decide[1].if.security`. */
export function pathText(path: readonly PropertyKey[]): string {
  return path.map((key, at) => (typeof key === "number" ? `[${key}]` : `${at === 0 ? "" : "."}${shown(String(key))}`)).join("");
}

/** Edits between two names, a swap of neighbours counting as one. */
function distance(a: string, b: string): number {
  const rows = [Array.from({ length: b.length + 1 }, (_, at) => at)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      row.push(best);
    }
    rows.push(row);
  }
  return rows[a.length]![b.length]!;
}

/** The known name a mistyped one was most likely meant to be, if any is close; a name longer than any key or group is meant as none. */
export function closest(name: string, known: readonly string[]): string | undefined {
  if (name.length > GROUP_NAME_MAX) return undefined;
  const lower = name.toLowerCase();
  const ranked = known.map((candidate) => ({ candidate, by: distance(lower, candidate.toLowerCase()) })).sort((a, b) => a.by - b.by);
  const best = ranked[0];
  return best !== undefined && best.by <= Math.max(1, Math.floor(name.length / 3)) ? best.candidate : undefined;
}

function groupProblems(groups: NonNullable<PolicyWorkflow["groups"]>): PathProblem[] {
  return Object.entries(groups).flatMap(([name, group]) => {
    const path = ["groups", name];
    if (name === EVERYONE) return [{ message: `\`groups.${EVERYONE}\` is built in; name the group something else.`, path }];
    if (!GroupName.allows(name)) return [{ message: `\`${pathText(path)}\` must be named in lowercase words joined by hyphens, starting with a letter, at most ${GROUP_NAME_MAX} characters.`, path }];
    if (Object.keys(group).length === 0) return [{ message: `\`${pathText(path)}\` must set association, teams or users.`, path }];
    return [];
  });
}

function referenceProblems(names: readonly string[], path: readonly PropertyKey[], known: readonly string[]): PathProblem[] {
  return names.flatMap((name) => {
    if (known.includes(name)) return [];
    const suggestion = closest(name, known);
    const fix = suggestion === undefined ? "define it under groups." : `did you mean \`${suggestion}\`?`;
    return [{ message: `\`${pathText(path)}\` names \`${name}\`, which is not a group; ${fix}`, path }];
  });
}

/** A step as a valid file writes it: a kind alone in `decide`, or a step whose `when.author` names kinds, groups, teams and people. */
type StepObject = { do: string; when?: { author?: readonly FileAuthorMatch[] } };
type WrittenStep = string | StepObject;
type StepList = readonly [readonly PropertyKey[], readonly WrittenStep[]];

/** A valid file's `actions`, before its authors are read. */
type WrittenActions = Partial<Record<VerdictWord, readonly WrittenStep[]>>;

function isKind(match: string): match is AuthorKind {
  return (AUTHOR_KINDS as readonly string[]).includes(match);
}

function isBuiltIn(name: string): name is keyof typeof AUTHOR_GROUPS {
  return Object.hasOwn(AUTHOR_GROUPS, name);
}

/** The group names a step's `when.author` holds, as the file wrote them. */
function namedGroups(step: WrittenStep): string[] {
  if (typeof step === "string") return [];
  return (step.when?.author ?? []).flatMap((match) => (typeof match === "string" && !isKind(match) ? [match] : []));
}

function stepLists(workflow: PolicyWorkflow, actions: WrittenActions | undefined): StepList[] {
  const verdicts = VERDICTS.flatMap((verdict): StepList[] => {
    const steps = actions?.[verdict];
    return steps ? [[["actions", verdict], steps]] : [];
  });
  const decide = (workflow.decide ?? []).flatMap((rule, at): StepList[] => (Array.isArray(rule.do) ? [[["decide", at, "do"], rule.do]] : []));
  return [...verdicts, ...decide];
}

function stepReferenceProblems(workflow: PolicyWorkflow, actions: WrittenActions | undefined, known: readonly string[]): PathProblem[] {
  return stepLists(workflow, actions).flatMap(([path, steps]) => steps.flatMap((step, at) => referenceProblems(namedGroups(step), [...path, at, "when", "author"], known)));
}

function providerProblems(workflow: PolicyWorkflow): PathProblem[] {
  const named = BLOCK_KINDS.flatMap((kind) => {
    const block = workflow[kind];
    return block?.on && block.provider !== undefined ? [{ kind, provider: block.provider }] : [];
  });
  const first = named[0];
  if (!first) return [];
  return named
    .filter(({ provider }) => provider !== first.provider)
    .map(({ kind, provider }) => ({
      message: `\`${kind}.provider\` is ${provider} but \`${first.kind}.provider\` is ${first.provider}; blocks that are on must name the same provider.`,
      path: [kind, "provider"],
    }));
}

export function kindsOf(written: DecideRule["do"]): string[] {
  return (Array.isArray(written) ? written : [written]).map((item) => (typeof item === "string" ? item : item.do));
}

/** The outcomes a block condition names; `{ findings }` names only findings. */
function outcomesOf(condition: DecideRule["if"][BlockKind]): readonly string[] {
  if (typeof condition === "string") return [condition];
  if (Array.isArray(condition)) return condition;
  return [];
}

function ruleProblems(rule: DecideRule, at: number, workflow: PolicyWorkflow): PathProblem[] {
  if (Object.keys(rule.if).length === 0) return [{ message: `\`decide[${at}].if\` must set a condition.`, path: ["decide", at, "if"] }];
  const kinds = kindsOf(rule.do);
  const mixed = kinds.includes("nothing") && kinds.length > 1 ? [{ message: `\`decide[${at}].do\` can't mix \`nothing\` with other actions; keep one or the other.`, path: ["decide", at, "do"] }] : [];
  const reviewing = kinds.includes("review") ? [{ message: `\`decide[${at}].do\` can't use \`review\` yet; use \`request-review\` or remove it.`, path: ["decide", at, "do"] }] : [];
  const approving = kinds.includes("approve") || kinds.includes("merge");
  const blocks = BLOCK_KINDS.flatMap((kind) => {
    const condition = rule.if[kind];
    if (condition === undefined) return [];
    const path = ["decide", at, "if", kind];
    if (workflow[kind]?.on !== true) return [{ message: `\`${pathText(path)}\`: \`${kind}\` is not turned on in this file; set \`${kind}.on: true\` or remove the condition.`, path }];
    if (approving && outcomesOf(condition).includes("incomplete")) return [{ message: `\`${pathText(path)}\` can't match incomplete in a rule that approves or merges; incomplete is never clean.`, path }];
    return [];
  });
  return [...mixed, ...reviewing, ...blocks];
}

/**
 * What the schema cannot say: group names, the groups blocks, rules and steps name, one provider, and approving only
 * what is clean. `actions` is the file's, as written.
 */
export function workflowProblems(workflow: PolicyWorkflow, actions: WrittenActions | undefined): PathProblem[] {
  // Only names that are valid groups are offered as what a mistyped name meant, so a long invalid name costs nothing.
  const own = Object.keys(workflow.groups ?? {}).filter((name) => GroupName.allows(name));
  const known = [...new Set([...own, ...Object.keys(AUTHOR_GROUPS), EVERYONE])];
  return [
    ...(actions !== undefined && workflow.decide !== undefined ? [{ message: "`actions` and `decide` can't both be set; move the actions into decide.", path: ["actions"] }] : []),
    ...groupProblems(workflow.groups ?? {}),
    ...BLOCK_KINDS.flatMap((kind) => referenceProblems(workflow[kind]?.for ?? [], [kind, "for"], known)),
    ...(workflow.decide ?? []).flatMap((rule, at) => referenceProblems(rule.if.author ?? [], ["decide", at, "if", "author"], known)),
    ...stepReferenceProblems(workflow, actions, known),
    ...providerProblems(workflow),
    ...(workflow.decide ?? []).flatMap((rule, at) => ruleProblems(rule, at, workflow)),
  ];
}

/**
 * Who a step is for, once the file is valid: a built-in group no file group replaces reads as its kinds, which is all it
 * ever matches; a file group, and `everyone`, as `{ group }`, matched against the author's groups.
 */
function readAuthors(author: readonly FileAuthorMatch[], groups: Readonly<Record<string, unknown>>): AuthorMatch[] {
  return author.flatMap((match): AuthorMatch[] => {
    if (typeof match !== "string") return [match];
    if (isKind(match)) return [match];
    if (isBuiltIn(match) && !Object.hasOwn(groups, match)) return [...AUTHOR_GROUPS[match]];
    return [{ group: match }];
  });
}

/** A valid file's step with its `when.author` read as `readAuthors` says. */
export function withAuthors<T extends StepObject>(step: T, groups: Readonly<Record<string, unknown>>): T {
  if (!step.when?.author) return step;
  return { ...step, when: { ...step.when, author: readAuthors(step.when.author, groups) } };
}

const UNCLEAN_KINDS: readonly string[] = ["approve", "merge"];

/**
 * Schema 3 `actions` as `decide`: each verdict's steps become one rule on that triage outcome, every step kept with its
 * target and conditions, and limited to the events the actions wake on when they wake on fewer than all. A Pass or Fail
 * with no steps did nothing, so it maps to `nothing`; an Unsure with none maps to no rule, which `decide` flags for a
 * maintainer, as the Unsure label did. With a block on, approve and merge run only when at least one block ran and every block that ran is clean:
 * otherwise a second rule runs the other steps, each in its own place so its effect stays the same.
 */
export function decideOf(actions: PolicyActions, blocksOn: boolean): DecideRule[] {
  const limited = POLICY_EVENTS.some((event) => !actions.when.includes(event));
  return VERDICTS.flatMap((verdict): DecideRule[] => {
    const condition = { triage: verdict, ...(limited && { event: [...actions.when] }) };
    const steps: Step[] = actions[verdict];
    if (steps.length === 0) return verdict === "unsure" ? [] : [{ if: condition, do: "nothing" }];
    if (!blocksOn || !steps.some((step) => UNCLEAN_KINDS.includes(step.do))) return [{ if: condition, do: steps }];
    const unclean = steps.map((step): Step => (UNCLEAN_KINDS.includes(step.do) ? { do: "nothing" } : step));
    return [{ if: { ...condition, all: "clean" }, do: steps }, { if: condition, do: unclean }];
  });
}
