// A batch of edits to a schema 3 policy file, applied on the parsed document so comments and untouched pairs stay.
// `exportPolicyFile` rebuilds the file with `stringify`, which drops them; this path must not.
import { type } from "arktype";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLSeq } from "yaml";
import { asRecord } from "@corbits/common";
import { CATALOG_IDS, emptyPack, isSizeRule, readCheckPack, type CatalogId } from "./check-pack.js";
import { checkPolicyFile, policyFileReason } from "./policy-file.js";
import { policyRuleSchema } from "./policy-rules.js";
import { withoutReserved } from "./policy-workflow.js";
import { catalogSentence } from "./rule-prose.js";

const RuleId = "string > 0";

export const PolicyPatchChange = type({ kind: "'rule'", id: RuleId, enabled: "boolean" })
  .or({ kind: "'rule-options'", id: RuleId, options: "Record<string, unknown>" })
  .or({ kind: "'add-rule'", rule: policyRuleSchema })
  .or({ kind: "'remove-rule'", id: RuleId })
  .or({ kind: "'code-review'", on: "boolean" })
  .or({ kind: "'strip-reserved'" });
export type PolicyPatchChange = typeof PolicyPatchChange.infer;

export const PolicyPatchChanges = PolicyPatchChange.array().atLeastLength(1).atMostLength(40);

type PolicyRule = typeof policyRuleSchema.infer;

/** `changed` is false when the patched file reads the same as before, however the YAML library re-spaced it. */
type PolicyPatchOutcome = { ok: true; text: string; changed: boolean } | { ok: false; message: string };

const MIGRATION = "This file has no rules list. It is the older policy shape and needs converting before it can be changed.";
const WRITTEN = { lineWidth: 0, flowCollectionPadding: false } as const;
/** A rule's keys that are not what it checks, so changing them leaves its sentence as it is. */
const NOTE_KEYS = ["text", "reason", "evidence", "enabled", "onFail", "label"];

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

/** `parsedPolicy` refuses a file without a rules list unless the batch only strips reserved blocks, and no change removes it. */
function rulesOf(doc: Document): YAMLSeq {
  const rules = doc.get("rules", true);
  if (!isSeq(rules)) throw new Error("the policy file lost its rules list");
  return rules;
}

function ruleIndex(rules: YAMLSeq, id: string): number {
  return rules.items.findIndex((item) => ruleIdAt(item) === id);
}

/** A plain object pushed onto `rules` is invisible to `ruleIdAt`, so a later change in the batch would miss it. */
function appendRule(doc: Document, rule: unknown): void {
  rulesOf(doc).add(doc.createNode(rule));
}

/** Skip a write that would replace a pair with the value it already holds, so asking again does not rewrite the line. */
function setPair(doc: Document, path: readonly (string | number)[], value: unknown): void {
  const current = doc.getIn(path);
  if (current === value || JSON.stringify(current) === JSON.stringify(value)) return;
  doc.setIn(path, value);
}

/** Its sentence stands until `writeSentences` writes it from the limits the batch sets; its reason comes from the batch. */
function addedCatalogRule(id: CatalogId, repo: string): Record<string, unknown> {
  return { check: id, text: `${catalogSentence(id, emptyPack(repo))}.`, evidence: ["maintainer-stated"], enabled: true };
}

/**
 * The built-in rules a batch turns on or gives new limits: only these must hold their required fields, and `resentence`
 * lists those whose sentence is rewritten from their limits, which are the rules it turns on without one and gives new
 * limits, unless their text is set in the batch (`ownText`).
 */
type Touched = { rules: Set<CatalogId>; resentence: Set<CatalogId>; ownText: Set<CatalogId> };

/** A rule given its own `text` anywhere in the batch keeps it. */
function touch(touched: Touched, id: CatalogId): void {
  touched.rules.add(id);
  if (!touched.ownText.has(id)) touched.resentence.add(id);
}

function applyEnabled(doc: Document, repo: string, touched: Touched, id: string, enabled: boolean): string | undefined {
  const rules = rulesOf(doc);
  const index = ruleIndex(rules, id);
  if (index >= 0) {
    // A rule without `enabled` is on, so turning it on changes nothing; turned back on, it keeps its own text.
    if ((doc.getIn(["rules", index, "enabled"]) !== false) === enabled) return undefined;
    if (enabled && isCatalogId(id)) touched.rules.add(id);
    setPair(doc, ["rules", index, "enabled"], enabled);
    return undefined;
  }
  if (!isCatalogId(id)) return unknown(id);
  if (!enabled) return missing(id);
  appendRule(doc, addedCatalogRule(id, repo));
  touch(touched, id);
  return undefined;
}

/**
 * `enabled` among the options goes through `applyEnabled`, so a rule turned on here is held to the same checks, and a
 * built-in rule not in the file is added the same way.
 */
function applyOptions(doc: Document, repo: string, touched: Touched, id: string, options: Record<string, unknown>): string | undefined {
  if ("check" in options || "id" in options) return `Rule ${id}'s check and id cannot be changed.`;
  const rules = rulesOf(doc);
  const { enabled, ...rest } = options;
  const problem = typeof enabled === "boolean" ? applyEnabled(doc, repo, touched, id, enabled) : undefined;
  if (problem !== undefined) return problem;
  if (typeof enabled !== "boolean" && enabled !== undefined) rest.enabled = enabled;
  const index = ruleIndex(rules, id);
  if (index < 0) return isCatalogId(id) ? missing(id) : unknown(id);
  if (isCatalogId(id)) {
    const limits = Object.entries(options).filter(([key]) => !NOTE_KEYS.includes(key));
    if (limits.some(([key, value]) => JSON.stringify(doc.getIn(["rules", index, key])) !== JSON.stringify(value))) touch(touched, id);
    if ("text" in options) {
      touched.ownText.add(id);
      touched.resentence.delete(id);
    }
  }
  for (const [key, value] of Object.entries(rest)) setPair(doc, ["rules", index, key], value);
  return undefined;
}

/** A built-in rule added here is held to what turning it on holds it to, and keeps the text it is added with. */
function applyAdd(doc: Document, touched: Touched, rule: PolicyRule): string | undefined {
  const rules = rulesOf(doc);
  const id = fileRuleId(rule);
  if (ruleIndex(rules, id) >= 0) return present(id);
  appendRule(doc, rule);
  if (isCatalogId(id)) {
    touched.ownText.add(id);
    touched.rules.add(id);
  }
  return undefined;
}

function applyRemove(doc: Document, id: string): string | undefined {
  const rules = rulesOf(doc);
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

/**
 * Takes out what Triage reads the file without (`withoutReserved`). A block's path is its key and a rule's starts
 * `decide` and its index; the last go first so the rules before them keep their places.
 */
function applyStripReserved(doc: Document): void {
  const paths = withoutReserved(asRecord(doc.toJS()) ?? {}).pending.map(({ path }) => path.slice(0, 2));
  for (const path of paths.reverse()) doc.deleteIn(path);
}

function applyChange(doc: Document, repo: string, touched: Touched, change: PolicyPatchChange): string | undefined {
  switch (change.kind) {
    case "rule":
      return applyEnabled(doc, repo, touched, change.id, change.enabled);
    case "rule-options":
      return applyOptions(doc, repo, touched, change.id, change.options);
    case "add-rule":
      return applyAdd(doc, touched, change.rule);
    case "remove-rule":
      return applyRemove(doc, change.id);
    case "code-review":
      return applyCodeReview(doc, change.on);
    case "strip-reserved":
      applyStripReserved(doc);
      return undefined;
  }
}

/** `rules` is needed by every change but `strip-reserved`, which a file that extends another or has the older shape takes too. */
function parsedPolicy(text: string, needsRules: boolean): Document | string {
  const doc = parseDocument(text, { schema: "core", prettyErrors: false });
  const error = doc.errors[0] ?? doc.warnings[0];
  if (error) return `The policy file is not YAML: ${error.message.replace(/\.$/, "")}.`;
  if (!isMap(doc.contents)) return "The policy file must be a mapping.";
  if (needsRules && !isSeq(doc.get("rules", true))) return MIGRATION;
  return doc;
}

/** The limit a built-in rule must be given when it is turned on: a size rule's `max` or forbidden paths' `paths`. */
export function requiredField(id: CatalogId): "max" | "paths" | undefined {
  if (isSizeRule(id)) return "max";
  if (id === "no-forbidden-paths") return "paths";
  return undefined;
}

/** A size or path rule is not given a made-up limit, nor a turned-on rule a made-up reason; the batch has to set them, or the refusal names both. */
function missingRequired(doc: Document, touched: ReadonlySet<CatalogId>): string | undefined {
  const rules = rulesOf(doc);
  for (const id of touched) {
    const item = rules.items[ruleIndex(rules, id)];
    if (!isMap(item)) continue;
    const field = requiredField(id);
    if (field !== undefined && !item.has(field)) return `Rule ${id} is missing ${field}.`;
    if (!item.has("reason")) return `Rule ${id} is missing reason.`;
  }
  return undefined;
}

/** Each rule in `resentence` gets the sentence its limits make, read from `policy`, the checked file's. */
function writeSentences(doc: Document, repo: string, resentence: ReadonlySet<CatalogId>, policy: Record<string, unknown>): void {
  const rules = rulesOf(doc);
  const checks = asRecord(policy.checks);
  if (!checks) return;
  for (const id of resentence) {
    const index = ruleIndex(rules, id);
    if (index < 0) continue;
    const pack = readCheckPack({ ...emptyPack(repo), checks: { [id]: checks[id] } }, repo);
    doc.setIn(["rules", index, "text"], `${catalogSentence(id, pack)}.`);
  }
}

function checkedText(doc: Document, repo: string): { text: string; policy: Record<string, unknown> } | string {
  const text = doc.toString(WRITTEN);
  const checked = checkPolicyFile(text, repo);
  if (!checked.ok) return policyFileReason(checked.problems);
  if (checked.pending) return policyFileReason(checked.pending);
  return { text, policy: checked.policy };
}

/** The file after `changes`, or why the batch cannot be applied. The result passes `checkPolicyFile`. */
export function patchPolicyFile(text: string, repo: string, changes: readonly PolicyPatchChange[]): PolicyPatchOutcome {
  const parsed = parsedPolicy(text, changes.some((change) => change.kind !== "strip-reserved"));
  if (typeof parsed === "string") return refused(parsed);
  const original = JSON.stringify(parsed.toJS());
  const touched: Touched = { rules: new Set(), resentence: new Set(), ownText: new Set() };
  for (const change of changes) {
    const problem = applyChange(parsed, repo, touched, change);
    if (problem !== undefined) return refused(problem);
  }
  const required = touched.rules.size === 0 ? undefined : missingRequired(parsed, touched.rules);
  if (required !== undefined) return refused(required);
  const patched = checkedText(parsed, repo);
  if (typeof patched === "string") return refused(patched);
  if (touched.resentence.size === 0) return { ok: true, text: patched.text, changed: JSON.stringify(parsed.toJS()) !== original };
  writeSentences(parsed, repo, touched.resentence, patched.policy);
  const written = checkedText(parsed, repo);
  if (typeof written === "string") return refused(written);
  return { ok: true, text: written.text, changed: JSON.stringify(parsed.toJS()) !== original };
}
