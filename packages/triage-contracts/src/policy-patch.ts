// A batch of edits to a schema 3 policy file, applied on the parsed document so comments and untouched pairs stay.
// `exportPolicyFile` rebuilds the file with `stringify`, which drops them; this path must not.
import { type } from "arktype";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLSeq } from "yaml";
import { CATALOG_IDS, emptyPack, type CatalogId } from "./check-pack.js";
import { checkPolicyFile, policyFileReason } from "./policy-file.js";
import { policyRuleSchema } from "./policy-rules.js";
import { catalogSentence } from "./rule-prose.js";

const RuleId = "string > 0";

export const PolicyPatchChange = type({ kind: "'rule'", id: RuleId, enabled: "boolean" })
  .or({ kind: "'rule-options'", id: RuleId, options: "Record<string, unknown>" })
  .or({ kind: "'add-rule'", rule: policyRuleSchema })
  .or({ kind: "'remove-rule'", id: RuleId })
  .or({ kind: "'code-review'", on: "boolean" });
export type PolicyPatchChange = typeof PolicyPatchChange.infer;

export const PolicyPatchChanges = PolicyPatchChange.array().atLeastLength(1).atMostLength(40);
export type PolicyPatchChanges = typeof PolicyPatchChanges.infer;

type PolicyRule = typeof policyRuleSchema.infer;

export type PolicyPatchOutcome = { ok: true; text: string } | { ok: false; message: string };

const MIGRATION = "This file has no rules list. It is the older policy shape and needs converting before it can be changed.";
const ADDED_REASON = "Set while updating this policy file.";

/** A built-in rule's id is its check; a custom rule's is its id. */
export function fileRuleId(rule: PolicyRule): string {
  if (rule.check === "model" || rule.check === "text" || rule.check === "code-patterns") return rule.id;
  return rule.check;
}

function refused(message: string): PolicyPatchOutcome {
  return { ok: false, message };
}

function isCatalogId(id: string): id is CatalogId {
  return (CATALOG_IDS as readonly string[]).includes(id);
}

function unknown(id: string): string {
  return `Unknown rule ${id}.`;
}

function missing(id: string): string {
  return `Rule ${id} is not in the file.`;
}

function present(id: string): string {
  return `Rule ${id} is already in the file.`;
}

function scalarText(node: unknown): string | undefined {
  if (!isScalar(node) || typeof node.value !== "string") return undefined;
  return node.value;
}

function ruleIdAt(item: unknown): string | undefined {
  if (!isMap(item)) return undefined;
  const check = scalarText(item.get("check", true));
  if (check !== undefined && isCatalogId(check)) return check;
  return scalarText(item.get("id", true));
}

function rulesOf(doc: Document): YAMLSeq | undefined {
  const rules = doc.get("rules", true);
  return isSeq(rules) ? rules : undefined;
}

function ruleIndex(rules: YAMLSeq, id: string): number {
  return rules.items.findIndex((item) => ruleIdAt(item) === id);
}

/** Skip a write that would replace a pair with the value it already holds, so asking again does not rewrite the line. */
function setPair(doc: Document, path: readonly (string | number)[], value: unknown): void {
  const current = doc.getIn(path);
  if (current === value || JSON.stringify(current) === JSON.stringify(value)) return;
  doc.setIn(path, value);
}

function addedCatalogRule(id: CatalogId, repo: string): Record<string, unknown> {
  return {
    check: id,
    text: `${catalogSentence(id, emptyPack(repo))}.`,
    reason: ADDED_REASON,
    evidence: ["maintainer-stated"],
    enabled: true,
  };
}

function applyEnabled(doc: Document, repo: string, id: string, enabled: boolean): string | undefined {
  const rules = rulesOf(doc);
  if (!rules) return MIGRATION;
  const index = ruleIndex(rules, id);
  if (index >= 0) {
    setPair(doc, ["rules", index, "enabled"], enabled);
    return undefined;
  }
  if (!isCatalogId(id)) return unknown(id);
  if (!enabled) return missing(id);
  doc.addIn(["rules"], addedCatalogRule(id, repo));
  return undefined;
}

function applyOptions(doc: Document, id: string, options: Record<string, unknown>): string | undefined {
  const rules = rulesOf(doc);
  if (!rules) return MIGRATION;
  const index = ruleIndex(rules, id);
  if (index < 0) return isCatalogId(id) ? missing(id) : unknown(id);
  for (const [key, value] of Object.entries(options)) setPair(doc, ["rules", index, key], value);
  return undefined;
}

function applyAdd(doc: Document, rule: PolicyRule): string | undefined {
  const rules = rulesOf(doc);
  if (!rules) return MIGRATION;
  const id = fileRuleId(rule);
  if (ruleIndex(rules, id) >= 0) return present(id);
  doc.addIn(["rules"], rule);
  return undefined;
}

function applyRemove(doc: Document, id: string): string | undefined {
  const rules = rulesOf(doc);
  if (!rules) return MIGRATION;
  const index = ruleIndex(rules, id);
  if (index < 0) return isCatalogId(id) ? missing(id) : unknown(id);
  rules.delete(index);
  return undefined;
}

function applyCodeReview(doc: Document, on: boolean): string | undefined {
  const block = doc.get("code-review", true);
  if (block !== undefined && !isMap(block)) return "`code-review` is not a block, so its on key cannot be set.";
  setPair(doc, ["code-review", "on"], on);
  return undefined;
}

function applyChange(doc: Document, repo: string, change: PolicyPatchChange): string | undefined {
  switch (change.kind) {
    case "rule":
      return applyEnabled(doc, repo, change.id, change.enabled);
    case "rule-options":
      return applyOptions(doc, change.id, change.options);
    case "add-rule":
      return applyAdd(doc, change.rule);
    case "remove-rule":
      return applyRemove(doc, change.id);
    case "code-review":
      return applyCodeReview(doc, change.on);
  }
}

function parsedPolicy(text: string): Document | string {
  const doc = parseDocument(text, { schema: "core", prettyErrors: false });
  const error = doc.errors[0] ?? doc.warnings[0];
  if (error) return `The policy file is not YAML: ${error.message.replace(/\.$/, "")}.`;
  if (!isMap(doc.contents)) return "The policy file must be a mapping.";
  if (!isSeq(doc.get("rules", true))) return MIGRATION;
  return doc;
}

/** The file after `changes`, or why the batch cannot be applied. The result passes `checkPolicyFile`. */
export function patchPolicyFile(text: string, repo: string, changes: readonly PolicyPatchChange[]): PolicyPatchOutcome {
  const parsed = parsedPolicy(text);
  if (typeof parsed === "string") return refused(parsed);
  for (const change of changes) {
    const problem = applyChange(parsed, repo, change);
    if (problem !== undefined) return refused(problem);
  }
  const patched = parsed.toString({ lineWidth: 0 });
  const checked = checkPolicyFile(patched, repo);
  if (!checked.ok) return refused(policyFileReason(checked.problems));
  return { ok: true, text: patched };
}
