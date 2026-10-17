// The policy file's schema 3: a list of rules, each one sentence with how it is checked and why it exists, and steps per
// verdict that run only when their `when` conditions hold. It is read by mapping it onto the stored policy's shape, so
// the stored policy's reader stays the one authority on what a policy may hold.
import { type } from "arktype";
import { asRecord } from "@corbits/common";
import { CATALOG_IDS, CustomId, Evidence, ISSUE_TRACKERS, Label, POLICY_EVENTS, stepListSchema, Text, TEXT_FIELDS, TEXT_MATCHES, VERDICTS, withAuthorKinds, type CatalogId } from "./check-pack.js";

const Lines = Text.array().atLeastLength(1).atMostLength(50);
const Limit = type("number.integer").atLeast(1);

/** A built-in rule's id is its check; a model or text rule names its own. */
const RULE_BASE = { "+": "reject", text: Text, reason: Text, evidence: Evidence, "enabled?": "boolean" } as const;
const OWN_RULE = { ...RULE_BASE, id: CustomId } as const;

const SIMPLE_CHECKS = ["focused", "docs", "no-merge-conflicts", "ci-green"] as const satisfies readonly CatalogId[];

const RuleSchema = type({ ...RULE_BASE, check: "'max-files-changed' | 'max-lines-changed'", max: Limit })
  .or({ ...RULE_BASE, check: "'linked-issue'", "tracker?": type.enumerated(...ISSUE_TRACKERS.filter((tracker) => tracker !== "off")) })
  .or({ ...RULE_BASE, check: "'no-forbidden-paths'", paths: Lines })
  .or({ ...RULE_BASE, check: type.enumerated(...SIMPLE_CHECKS) })
  .or({ ...OWN_RULE, check: "'model'" })
  .or({ ...OWN_RULE, check: "'text'", fields: type.enumerated(...TEXT_FIELDS).array().atLeastLength(1), failWhen: type.enumerated(...TEXT_MATCHES), phrases: Lines });

type PolicyRule = typeof RuleSchema.infer;

export const policyRulesSchema = type({
  "+": "reject",
  "extends?": Text,
  rules: RuleSchema.array(),
  "actions?": { "+": "reject", "on?": type.enumerated(...POLICY_EVENTS).array().atLeastLength(1), "pass?": stepListSchema, "fail?": stepListSchema, "unsure?": stepListSchema },
  "labels?": { "+": "reject", "pass?": Label, "fail?": Label, "unsure?": Label },
});

type PolicyRulesFile = typeof policyRulesSchema.infer;

/** Where in the file each problem is, as keys from its root, so a reader can point at the line. */
export class PolicyFileError extends Error {
  constructor(message: string, readonly problems: ReadonlyArray<{ message: string; path: readonly PropertyKey[] }>) {
    super(message);
  }
}

function refuse(message: string, path: readonly PropertyKey[]): never {
  throw new PolicyFileError(message, [{ message, path }]);
}

/** A file holds schema 3 when it lists `rules`. */
export function isPolicyRulesFile(file: Record<string, unknown>): boolean {
  return file.rules !== undefined;
}

/** The name a model or text rule shows under, from its id. */
export function ruleNameOf(id: string): string {
  const words = id.replace(/-/g, " ");
  return `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

function catalogRow(rule: Extract<PolicyRule, { check: CatalogId }>): Record<string, unknown> {
  const row = { text: rule.text, reason: rule.reason, evidence: rule.evidence, enabled: rule.enabled !== false };
  switch (rule.check) {
    case "max-files-changed":
      return { ...row, maxFiles: rule.max };
    case "max-lines-changed":
      return { ...row, maxLines: rule.max };
    case "linked-issue":
      return rule.tracker === undefined ? row : { ...row, tracker: rule.tracker };
    case "no-forbidden-paths":
      return { ...row, forbiddenGlobs: rule.paths };
    default:
      return row;
  }
}

function customRow(rule: Extract<PolicyRule, { check: "model" | "text" }>): Record<string, unknown> {
  const { id } = rule;
  const base = { id, name: ruleNameOf(id), group: "pull-request", reason: rule.reason, evidence: rule.evidence, ...(rule.enabled === false && { enabled: false }) };
  if (rule.check === "model") return { ...base, kind: "model", shape: "is-true", claim: rule.text };
  return { ...base, text: rule.text, kind: "text", fields: rule.fields, failWhen: rule.failWhen, phrases: rule.phrases };
}

function isCatalogRule(rule: PolicyRule): rule is Extract<PolicyRule, { check: CatalogId }> {
  return (CATALOG_IDS as readonly string[]).includes(rule.check);
}

function ruleId(rule: PolicyRule): string {
  return isCatalogRule(rule) ? rule.check : rule.id;
}

function mapRules(rules: PolicyRule[]): { checks: Record<string, unknown>; custom: Array<Record<string, unknown>> } {
  const checks: Record<string, unknown> = {};
  const custom: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const [at, rule] of rules.entries()) {
    const id = ruleId(rule);
    if (seen.has(id)) refuse(`Rule ${id} is listed twice.`, ["rules", at]);
    seen.add(id);
    if (isCatalogRule(rule)) checks[id] = catalogRow(rule);
    else custom.push(customRow(rule));
  }
  return { checks, custom };
}

/** Steps written as `for` belong to the old shape; a schema 3 step says who it is for in `when`. */
function refuseFor(actions: Record<string, unknown> | undefined): void {
  for (const verdict of VERDICTS) {
    const steps = actions?.[verdict];
    if (!Array.isArray(steps)) continue;
    const at = steps.findIndex((step) => asRecord(step)?.for !== undefined);
    if (at >= 0) refuse(`${verdict} step ${at + 1} must say who it is for in when.author, not for.`, ["actions", verdict, at]);
  }
}

/** Without `extends`, a verdict the file leaves out has no steps and every event wakes the actions; with it, what the file leaves out is the shared policy's. */
function actionsOf(file: PolicyRulesFile): Record<string, unknown> | undefined {
  const { on, ...lists } = file.actions ?? {};
  if (file.extends === undefined) return { when: on ?? [...POLICY_EVENTS], ...Object.fromEntries(VERDICTS.map((verdict) => [verdict, lists[verdict] ?? []])) };
  if (file.actions === undefined) return undefined;
  return { ...(on && { when: on }), ...lists };
}

/** The stored policy's shape for a schema 3 file: rules become built-in rows and custom rules, and `actions.on` the events the actions wake on. */
export function rulesToPolicy(raw: Record<string, unknown>): Record<string, unknown> {
  refuseFor(asRecord(raw.actions));
  const file = policyRulesSchema(withAuthorKinds(raw));
  if (file instanceof type.errors) throw new PolicyFileError(file.summary, file.map((error) => ({ message: error.message, path: error.path })));
  const actions = actionsOf(file);
  return {
    ...(file.extends !== undefined && { extends: file.extends }),
    ...mapRules(file.rules),
    ...(actions && { actions }),
    ...(file.labels && { labels: file.labels }),
  };
}
