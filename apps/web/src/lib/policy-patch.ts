// The Code review page's edits stay in the page as a list of changes until one patch opens a pull request with all of them.
import { CATALOG_IDS, catalogCheckEnabled, catalogSentence, customCheckEnabled, customSentence, CUSTOM_CHECK_CAP, CustomId, fileRuleId, isCatalogId, isModelCheck, isSizeRule, onFailText, ON_FAILS, QUALITY_CHECK_IDS, SIZE_RULES, type CatalogCheck, type CatalogId, type CheckPack, type CustomCheck, type ModelCustomCheck, type PolicyPatchChange } from "@corbits/triage-contracts";

export type Lane = "checks" | "judging";

export const LANES: Record<Lane, string> = { checks: "Checks", judging: "Judging" };

/**
 * `listed`: the file has the rule, so turning it on or off flips its `enabled`; a rule it lacks is added with a reason.
 * `onFail`: what its failure does when that is not failing the pull request, as the policy's sentences say it.
 */
export type RuleRow = { id: string; lane: Lane; sentence: string; onFail?: string; on: boolean; listed: boolean; needsModel: boolean };

export type FailWord = (typeof ON_FAILS)[number];

/** What a person entered to add a built-in rule the file lacks. */
export type Added = { reason: string; max?: number; paths?: string[] };

function addedRule(change: PolicyPatchChange): string | undefined {
  return change.kind === "add-rule" ? fileRuleId(change.rule) : undefined;
}

function changeId(change: PolicyPatchChange): string {
  switch (change.kind) {
    case "rule":
    case "rule-options":
    case "remove-rule":
      return change.id;
    case "add-rule":
      return fileRuleId(change.rule);
    case "code-review":
      return "code-review";
  }
}

/** The rows a batch changes, once each, in the order first changed. */
export function touchedIds(changes: readonly PolicyPatchChange[]): string[] {
  return [...new Set(changes.map(changeId))];
}

function listedOn(pack: CheckPack, id: string): boolean {
  if (isCatalogId(id)) return catalogCheckEnabled(pack, id);
  const row = pack.custom.find((item) => item.id === id);
  return row !== undefined && customCheckEnabled(row);
}

function isOn(pack: CheckPack, changes: readonly PolicyPatchChange[], id: string): boolean {
  if (changes.some((change) => addedRule(change) === id)) return true;
  const last = changes.findLast((change) => change.kind === "rule" && change.id === id);
  return last?.kind === "rule" ? last.enabled : listedOn(pack, id);
}

/** A switch set back to what the file says drops the row's changes; a rule added in the batch and turned off is dropped. */
export function flipRule(pack: CheckPack, changes: readonly PolicyPatchChange[], id: string, on: boolean): PolicyPatchChange[] {
  const rest = changes.filter((change) => changeId(change) !== id);
  if (on === listedOn(pack, id)) return rest;
  return [...rest, { kind: "rule", id, enabled: on }];
}

/** A built-in rule the file lacks: turned on, then given its reason and limit, which the route asks of a rule it adds. */
export function addCatalogRule(changes: readonly PolicyPatchChange[], id: CatalogId, added: Added): PolicyPatchChange[] {
  const rest = changes.filter((change) => changeId(change) !== id);
  return [...rest, { kind: "rule", id, enabled: true }, { kind: "rule-options", id, options: { ...added, evidence: ["maintainer-stated"] } }];
}

export function codeReviewOn(baseline: boolean, changes: readonly PolicyPatchChange[]): boolean {
  const last = changes.findLast((change) => change.kind === "code-review");
  return last?.kind === "code-review" ? last.on : baseline;
}

export function flipCodeReview(baseline: boolean, changes: readonly PolicyPatchChange[], on: boolean): PolicyPatchChange[] {
  const rest = changes.filter((change) => change.kind !== "code-review");
  return on === baseline ? rest : [...rest, { kind: "code-review", on }];
}

function laneOf(id: CatalogId): Lane {
  return (QUALITY_CHECK_IDS as readonly string[]).includes(id) ? "judging" : "checks";
}

/** The custom row the file's model rule `change` becomes, as the policy reads it. */
function judgeRow(change: Extract<PolicyPatchChange, { kind: "add-rule" }>): ModelCustomCheck | undefined {
  const { rule } = change;
  if (rule.check !== "model") return undefined;
  const onFail = rule.onFail === "fail" ? {} : { onFail: rule.onFail };
  return { id: rule.id, name: rule.id, group: "pull-request", kind: "model", shape: "is-true", claim: rule.text, reason: rule.reason, evidence: rule.evidence, ...onFail };
}

/** The pack with the judge rules a batch adds, so their sentences and on-fail words come from the same place as the file's. */
export function withAdded(pack: CheckPack, changes: readonly PolicyPatchChange[]): CheckPack {
  const added = changes.flatMap(function addedRow(change) {
    const row = change.kind === "add-rule" ? judgeRow(change) : undefined;
    return row ? [row] : [];
  });
  return added.length === 0 ? pack : { ...pack, custom: [...pack.custom, ...added] };
}

function customText(row: CustomCheck): string {
  return row.kind === "model" && row.shape === "is-true" ? row.claim : customSentence(row);
}

function onFirst(rows: RuleRow[]): RuleRow[] {
  return [...rows.filter((row) => row.on), ...rows.filter((row) => !row.on)];
}

/** Every built-in rule, each custom rule and each judge rule the batch adds, under its lane, the rules that are on first. */
export function ruleRows(pack: CheckPack, changes: readonly PolicyPatchChange[], hasModel: boolean): Record<Lane, RuleRow[]> {
  const shown = withAdded(pack, changes);
  function onFailOf(id: string): Pick<RuleRow, "onFail"> {
    const words = onFailText(shown, id);
    return words === undefined ? {} : { onFail: words };
  }
  const catalog = CATALOG_IDS.map(function catalogRow(id): RuleRow {
    const lane = laneOf(id);
    return { id, lane, sentence: catalogSentence(id, pack), ...onFailOf(id), on: isOn(pack, changes, id), listed: pack.checks[id] !== undefined, needsModel: lane === "judging" && !hasModel };
  });
  const custom = shown.custom.map(function customRow(row): RuleRow {
    const lane = isModelCheck(row) ? "judging" : "checks";
    const listed = pack.custom.includes(row);
    return { id: row.id, lane, sentence: customText(row), ...onFailOf(row.id), on: isOn(pack, changes, row.id), listed, needsModel: lane === "judging" && !hasModel };
  });
  const rows = [...catalog, ...custom];
  return { checks: onFirst(rows.filter((row) => row.lane === "checks")), judging: onFirst(rows.filter((row) => row.lane === "judging")) };
}

/** The rows whose state on the open pull request's branch differs from the default branch's, and code review if it does. */
export function differingIds(base: CheckPack, branch: CheckPack, baseReview: boolean, branchReview: boolean): string[] {
  const ids = [...new Set([...CATALOG_IDS, ...base.custom.map((row) => row.id), ...branch.custom.map((row) => row.id)])];
  const rules = ids.filter((id) => listedOn(base, id) !== listedOn(branch, id) || JSON.stringify(ruleOf(base, id)) !== JSON.stringify(ruleOf(branch, id)));
  return baseReview === branchReview ? rules : [...rules, "code-review"];
}

function ruleOf(pack: CheckPack, id: string): unknown {
  return isCatalogId(id) ? pack.checks[id] : pack.custom.find((row) => row.id === id);
}

/** "12 rules on. Judging is on. Code review is off." */
export function statusLine(rows: Record<Lane, RuleRow[]>, reviewOn: boolean): string {
  const on = [...rows.checks, ...rows.judging].filter((row) => row.on).length;
  const judging = rows.judging.some((row) => row.on) ? "on" : "off";
  return `${on} ${on === 1 ? "rule" : "rules"} on. Judging is ${judging}. Code review is ${reviewOn ? "on" : "off"}.`;
}

/** The sentence a built-in rule reads with what the person entered, the way the file will word it. */
function addedSentence(pack: CheckPack, id: CatalogId, options: Record<string, unknown>): string {
  const row: CatalogCheck = { enabled: true };
  if (isSizeRule(id) && typeof options.max === "number") row[SIZE_RULES[id]] = options.max;
  if (Array.isArray(options.paths)) row.forbiddenGlobs = options.paths.filter((path) => typeof path === "string");
  return catalogSentence(id, { ...pack, checks: { ...pack.checks, [id]: row } });
}

function rowSentence(pack: CheckPack, changes: readonly PolicyPatchChange[], id: string): string {
  const options = changes.find((change) => change.kind === "rule-options" && change.id === id);
  if (isCatalogId(id)) return options?.kind === "rule-options" ? addedSentence(pack, id, options.options) : catalogSentence(id, pack);
  const row = pack.custom.find((item) => item.id === id);
  return row ? customText(row) : id;
}

/** One sentence for each row the batch changes. */
export function changeSentences(pack: CheckPack, changes: readonly PolicyPatchChange[]): string[] {
  return touchedIds(changes).map(function sentence(id) {
    const last = changes.findLast((change) => changeId(change) === id);
    if (last?.kind === "code-review") return last.on ? "Turn on code review." : "Turn off code review.";
    const added = changes.find((change) => change.kind === "add-rule" && fileRuleId(change.rule) === id);
    if (added?.kind === "add-rule") return `Add the judge rule “${added.rule.text}”.`;
    return `${isOn(pack, changes, id) ? "Turn on" : "Turn off"} “${rowSentence(pack, changes, id)}”.`;
  });
}

function freeId(pack: CheckPack, changes: readonly PolicyPatchChange[], claim: string): string {
  const words = claim.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Cut at a word so the id never ends mid-word.
  const slug = words.length <= 48 ? words : words.slice(0, 49).replace(/-[^-]*$/, "");
  const base = CustomId.allows(slug) ? slug : "judge-rule";
  const taken = new Set<string>([...CATALOG_IDS, ...pack.custom.map((row) => row.id), ...changes.flatMap((change) => addedRule(change) ?? [])]);
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** Whether the file has room for another custom rule. */
export function hasCustomRoom(pack: CheckPack, changes: readonly PolicyPatchChange[]): boolean {
  return pack.custom.length + changes.filter((change) => change.kind === "add-rule").length < CUSTOM_CHECK_CAP;
}

/** "the description" and "says why the change is needed" make the claim the file stores as the rule's text. */
export function judgeClaim(subject: string, passes: string): string {
  return [subject.trim(), passes.trim()].filter((part) => part.length > 0).join(" ");
}

/**
 * A model rule as the file holds it: its text is the claim, it passes when the claim is true, and `onFail` is written
 * even when it is `fail`, so a file-wide default does not change what the person chose. The claim is its stated reason.
 */
export function judgeRule(pack: CheckPack, changes: readonly PolicyPatchChange[], claim: string, onFail: FailWord): PolicyPatchChange {
  return { kind: "add-rule", rule: { id: freeId(pack, changes, claim), check: "model", text: claim, reason: claim, evidence: ["maintainer-stated"], onFail } };
}
