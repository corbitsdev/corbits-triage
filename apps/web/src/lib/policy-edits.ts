// Edits stay in the page until one patch opens a pull request. The policy-file read names the file and not its text, so the
// text comes from a preview, which writes nothing.
import { CATALOG_IDS, CUSTOM_CHECK_CAP, QUALITY_CHECK_IDS, catalogSentence, checkPolicyFile, customSentence, fileRuleId, isCatalogId, isModelCheck, isSizeRule, readCheckPack, type CatalogId, type CheckPack, type CustomCheck, type PolicyPatchChange } from "@corbits/triage-contracts";

export type RuleLane = "checks" | "judging";

export type RuleRow = { id: string; lane: RuleLane; sentence: string; on: boolean; needsModel: boolean };

const ON_FAILS = ["fail", "ask", "label"] as const;
export type FailWord = (typeof ON_FAILS)[number];

export const FAIL_SENTENCES: Record<FailWord, string> = {
  fail: "On fail, the pull request fails.",
  ask: "On fail, a maintainer is asked.",
  label: "On fail, it is labelled and the verdict stays.",
};

const CUSTOM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type FilePolicy = { pack: CheckPack; codeReviewOn: boolean } | { problem: string };

/** The file's rules and whether code review is on, or the first reason it cannot be changed. */
export function policyFromText(text: string, repo: string): FilePolicy {
  const checked = checkPolicyFile(text, repo);
  if (!checked.ok) return { problem: checked.problems[0]?.message ?? "This policy can't be changed until the file is fixed." };
  try {
    return { pack: readCheckPack(checked.policy, repo), codeReviewOn: checked.workflow["code-review"]?.on === true };
  } catch (cause) {
    return { problem: cause instanceof Error ? cause.message : "This policy can't be changed until the file is fixed." };
  }
}

function present(pack: CheckPack, id: string): boolean {
  if (isCatalogId(id)) return pack.checks[id] !== undefined;
  return pack.custom.some((row) => row.id === id);
}

function baselineOn(pack: CheckPack, id: string): boolean {
  if (isCatalogId(id)) {
    const row = pack.checks[id];
    return row !== undefined && row.enabled !== false;
  }
  const row = pack.custom.find((item) => item.id === id);
  return row !== undefined && row.enabled !== false;
}

function editsRule(change: PolicyPatchChange, id: string): boolean {
  if (change.kind === "rule" || change.kind === "remove-rule" || change.kind === "rule-options") return change.id === id;
  return change.kind === "add-rule" && fileRuleId(change.rule) === id;
}

/** A size rule needs `max` and forbidden paths need `paths`, and only when the file does not already list the rule. */
export function absentValue(pack: CheckPack, id: string): "max" | "paths" | undefined {
  if (present(pack, id)) return undefined;
  if (isSizeRule(id)) return "max";
  return id === "no-forbidden-paths" ? "paths" : undefined;
}

export function ruleOn(pack: CheckPack, id: string, changes: readonly PolicyPatchChange[]): boolean {
  const added = changes.some((change) => change.kind === "add-rule" && fileRuleId(change.rule) === id);
  if (added) return true;
  const last = changes.findLast((change) => change.kind === "rule" && change.id === id);
  return last?.kind === "rule" ? last.enabled : baselineOn(pack, id);
}

export function codeReviewOn(baseline: boolean, changes: readonly PolicyPatchChange[]): boolean {
  const last = changes.findLast((change) => change.kind === "code-review");
  return last?.kind === "code-review" ? last.on : baseline;
}

/** A switch that returns to the file drops its change. A new size or path rule is not enabled until its value is set beside it. */
export function toggleRule(pack: CheckPack, changes: readonly PolicyPatchChange[], id: string, next: boolean): PolicyPatchChange[] {
  const rest = changes.filter((change) => !editsRule(change, id));
  const added = changes.some((change) => change.kind === "add-rule" && fileRuleId(change.rule) === id);
  if (added) return next ? [...changes] : rest;
  if (next === baselineOn(pack, id)) return rest;
  if (!next && !present(pack, id)) return rest;
  if (next && absentValue(pack, id) !== undefined) return rest;
  return [...rest, { kind: "rule", id, enabled: next }];
}

/** Enable a rule the file does not list, then set the limit or paths the person entered. The enable comes first so the option applies to it. */
export function withRequiredValue(changes: readonly PolicyPatchChange[], id: string, options: { max: number } | { paths: string[] }): PolicyPatchChange[] {
  const rest = changes.filter((change) => !editsRule(change, id));
  return [...rest, { kind: "rule", id, enabled: true }, { kind: "rule-options", id, options }];
}

/** False while a new size or path rule is enabled without the value the route requires. */
export function batchReady(pack: CheckPack, changes: readonly PolicyPatchChange[]): boolean {
  return changes.every(function ready(change) {
    if (change.kind !== "rule" || !change.enabled) return true;
    const field = absentValue(pack, change.id);
    if (field === undefined) return true;
    const options = changes.find((item) => item.kind === "rule-options" && item.id === change.id);
    if (options?.kind !== "rule-options") return false;
    if (field === "max") return typeof options.options.max === "number" && Number.isInteger(options.options.max) && options.options.max >= 1;
    const paths = options.options.paths;
    return Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === "string" && path.trim().length > 0);
  });
}

export function toggleCodeReview(baseline: boolean, changes: readonly PolicyPatchChange[], next: boolean): PolicyPatchChange[] {
  const rest = changes.filter((change) => change.kind !== "code-review");
  return next === baseline ? rest : [...rest, { kind: "code-review", on: next }];
}

function laneOf(id: CatalogId): RuleLane {
  return (QUALITY_CHECK_IDS as readonly string[]).includes(id) ? "judging" : "checks";
}

function customLane(row: CustomCheck): RuleLane {
  return isModelCheck(row) ? "judging" : "checks";
}

function customText(row: CustomCheck): string {
  return row.kind === "model" && row.shape === "is-true" ? row.claim : customSentence(row);
}

function sentenceOf(pack: CheckPack, id: string, changes: readonly PolicyPatchChange[]): string {
  if (isCatalogId(id)) return catalogSentence(id, pack);
  const row = pack.custom.find((item) => item.id === id);
  if (row) return customText(row);
  const added = changes.find((change) => change.kind === "add-rule" && fileRuleId(change.rule) === id);
  return added?.kind === "add-rule" && added.rule.check === "model" ? added.rule.text : id;
}

function onFirst(rows: RuleRow[]): RuleRow[] {
  return [...rows.filter((row) => row.on), ...rows.filter((row) => !row.on)];
}

/** Built-in rules, custom rules and a judge rule added in this batch. On rows sit above off rows. */
export function ruleRows(pack: CheckPack, changes: readonly PolicyPatchChange[], hasModel: boolean): Record<RuleLane, RuleRow[]> {
  const catalog = CATALOG_IDS.map(function rowOf(id): RuleRow {
    const on = ruleOn(pack, id, changes);
    const judging = laneOf(id) === "judging";
    return { id, lane: laneOf(id), sentence: catalogSentence(id, pack), on, needsModel: judging && !hasModel };
  });
  const custom = pack.custom.map(function rowOf(row): RuleRow {
    const lane = customLane(row);
    return { id: row.id, lane, sentence: customText(row), on: ruleOn(pack, row.id, changes), needsModel: lane === "judging" && !hasModel };
  });
  const added = changes.flatMap(function rowOf(change): RuleRow[] {
    if (change.kind !== "add-rule" || change.rule.check !== "model") return [];
    return [{ id: change.rule.id, lane: "judging", sentence: change.rule.text, on: true, needsModel: !hasModel }];
  });
  const rows = [...catalog, ...custom, ...added];
  return { checks: onFirst(rows.filter((row) => row.lane === "checks")), judging: onFirst(rows.filter((row) => row.lane === "judging")) };
}

export function judgingOn(rows: RuleRow[]): boolean {
  return rows.some((row) => row.on);
}

export function changeSentences(pack: CheckPack, changes: readonly PolicyPatchChange[]): string[] {
  return changes.map(function sentence(change) {
    switch (change.kind) {
      case "rule":
        return `${change.enabled ? "Turn on" : "Turn off"} ${sentenceOf(pack, change.id, changes)}.`;
      case "code-review":
        return change.on ? "Turn on code review." : "Turn off code review.";
      case "add-rule":
        return change.rule.check === "model" ? `Add a judge rule: ${change.rule.text}` : `Add ${fileRuleId(change.rule)}.`;
      case "remove-rule":
        return `Remove ${sentenceOf(pack, change.id, changes)}.`;
      case "rule-options":
        if (typeof change.options.max === "number") return `Set the limit to ${change.options.max.toLocaleString()}.`;
        if (Array.isArray(change.options.paths)) return `Set the paths to ${change.options.paths.join(", ")}.`;
        return `Change ${sentenceOf(pack, change.id, changes)}.`;
    }
  });
}

export function touchedIds(changes: readonly PolicyPatchChange[]): string[] {
  return changes.map(function idOf(change) {
    switch (change.kind) {
      case "rule":
      case "remove-rule":
      case "rule-options":
        return change.id;
      case "add-rule":
        return fileRuleId(change.rule);
      case "code-review":
        return "code-review";
    }
  });
}

function takenIds(pack: CheckPack, changes: readonly PolicyPatchChange[]): string[] {
  return [...CATALOG_IDS, ...pack.custom.map((row) => row.id), ...changes.flatMap((change) => (change.kind === "add-rule" ? [fileRuleId(change.rule)] : []))];
}

/** A model rule the file can hold: the claim is the check, it passes when the claim is true, and `onFail` is the fail answer. */
export function judgeRuleChange(pack: CheckPack, changes: readonly PolicyPatchChange[], claim: string, onFail: FailWord): PolicyPatchChange | undefined {
  const text = claim.trim();
  if (!text) return undefined;
  if (pack.custom.length + changes.filter((change) => change.kind === "add-rule").length >= CUSTOM_CHECK_CAP) return undefined;
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  let id = CUSTOM_ID.test(slug) ? slug : "judge-rule";
  const taken = takenIds(pack, changes);
  let n = 2;
  while (taken.includes(id)) {
    id = `${slug || "judge-rule"}-${n}`;
    n += 1;
  }
  return {
    kind: "add-rule",
    rule: { id, check: "model", text, reason: text, evidence: ["maintainer-stated"], ...(onFail !== "fail" && { onFail }) },
  };
}
