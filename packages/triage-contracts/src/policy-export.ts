// A stored policy written as a schema 3 policy file, and what two policies do differently. Both read the pack triage
// runs on, so a rule's wording, reason and evidence never count as a difference; what it checks and every step do.
import { stringify } from "yaml";
import {
  askRules,
  AUTHOR_GROUPS,
  CATALOG_IDS,
  CONVENTIONAL_FIELDS,
  CONVENTIONAL_TYPES,
  defaultOnFail,
  isSizeRule,
  labelRules,
  POLICY_EVENTS,
  SIZE_RULES,
  VERDICT_LABELS,
  VERDICTS,
  type AuthorMatch,
  type CatalogCheck,
  type CatalogId,
  type CheckPack,
  type CustomCheck,
  type FileGroup,
  type ModelCustomCheck,
  type OnFail,
  type PeopleTarget,
  type Step,
  type VerdictWord,
} from "./check-pack.js";
import type { PolicyDifference } from "./hub-responses.js";
import { ruleNameOf } from "./policy-rules.js";
import { catalogSentence, customSentence, ISSUE_TRACKER_NAMES } from "./rule-prose.js";

const REASON = "Set in the portal before the policy file.";
const EVIDENCE = ["maintainer-stated"];
export const VERDICT_NAMES: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };

export type PolicyFileExport = { text: string; unexpressed: string[] };

/** A rule as the file writes it: its sentence, what it checks, then why it exists. */
function written(row: OnFail & { reason?: string; evidence?: string[]; enabled?: boolean }, id: string, head: Record<string, unknown>, text: string, checks: Record<string, unknown>) {
  const failure = row.onFail ?? "fail";
  const onFail = { ...(failure !== defaultOnFail(id) && { onFail: failure }), ...(row.label !== undefined && { label: row.label }) };
  return { ...head, text, ...checks, ...onFail, reason: row.reason ?? REASON, evidence: row.evidence ?? EVIDENCE, ...(row.enabled === false && { enabled: false }) };
}

/** A built-in rule's parameters as schema 3 writes them; undefined when it has none it requires. */
function catalogParams(id: CatalogId, row: CatalogCheck): Record<string, unknown> | undefined {
  if (isSizeRule(id)) return row[SIZE_RULES[id]] === undefined ? undefined : { max: row[SIZE_RULES[id]] };
  switch (id) {
    case "linked-issue":
      if (row.tracker === "off") return undefined;
      return row.tracker === undefined ? {} : { tracker: row.tracker };
    case "no-forbidden-paths":
      return row.forbiddenGlobs?.length ? { paths: row.forbiddenGlobs } : undefined;
    case "regression-risk":
      return { ...(row.hotFileFixes !== undefined && { hotFileFixes: row.hotFileFixes }), ...(row.migrationGlobs && { migrations: row.migrationGlobs }) };
    case "sensitive-paths":
      return { ...(row.sensitiveGroups && { groups: row.sensitiveGroups }), ...(row.failAt && { failAt: row.failAt }), ...(row.labelAt && { labelAt: row.labelAt }) };
    case "risk":
      return { ...(row.medium !== undefined && { medium: row.medium }), ...(row.high !== undefined && { high: row.high }), ...(row.failAt && { failAt: row.failAt }), ...(row.labelAt && { labelAt: row.labelAt }) };
    case "conventional-commits":
      return { ...(row.types && { types: row.types }), ...(row.fields && { fields: row.fields }) };
    default:
      return {};
  }
}

/** A switched-off rule a file cannot hold is left out unsaid: off and absent check the same. */
function catalogRule(pack: CheckPack, id: CatalogId, unexpressed: string[]): Record<string, unknown>[] {
  const row = pack.checks[id];
  if (!row) return [];
  const params = catalogParams(id, row);
  if (!params) {
    if (row.enabled) unexpressed.push(`${catalogSentence(id, pack)} stops after the merge; a policy file can't hold it without a value.`);
    return [];
  }
  return [written(row, id, { check: id }, row.text ?? `${catalogSentence(id, pack)}.`, params)];
}

function customRule(row: CustomCheck, unexpressed: string[]): Record<string, unknown>[] {
  if (row.name !== ruleNameOf(row.id)) unexpressed.push(`${row.name} is called ${ruleNameOf(row.id)} in the file.`);
  if (row.kind === "text") {
    return [written(row, row.id, { id: row.id, check: "text" }, row.text ?? row.name, { fields: row.fields, failWhen: row.failWhen, phrases: row.phrases })];
  }
  if (row.kind === "code-patterns") {
    return [written(row, row.id, { id: row.id, check: "code-patterns" }, row.text ?? row.name, { ...(row.presets.length > 0 && { presets: row.presets }), ...(row.patterns.length > 0 && { patterns: row.patterns }) })];
  }
  if (row.shape === "is-true" && row.when === undefined && (row.scope ?? "pull-request") === "pull-request") {
    return [written(row, row.id, { id: row.id, check: "model" }, row.claim, {})];
  }
  unexpressed.push(`${row.name} stops after the merge; a policy file can't hold it.`);
  return [];
}

/** Author kinds a built-in group stands for, and a file group, written as the group, so the file reads as people wrote it. */
function authorGroups(author: readonly AuthorMatch[]): Array<string | AuthorMatch> {
  const out: Array<string | AuthorMatch> = [];
  for (let at = 0; at < author.length; ) {
    const match = author[at]!;
    const group = Object.entries(AUTHOR_GROUPS).find(([, kinds]) => kinds.every((kind, i) => author[at + i] === kind));
    if (typeof match === "object" && "group" in match) out.push(match.group);
    else out.push(group ? group[0] : match);
    at += group ? group[1].length : 1;
  }
  return out;
}

function fileStep(step: Step): Record<string, unknown> {
  if (!step.when?.author) return step;
  return { ...step, when: { ...step.when, author: authorGroups(step.when.author) } };
}

function fileActions(pack: CheckPack): Record<string, unknown> | undefined {
  const lists = VERDICTS.flatMap((verdict) => (pack.actions[verdict].length ? [[verdict, pack.actions[verdict].map(fileStep)]] : []));
  const every = POLICY_EVENTS.every((event) => pack.actions.when.includes(event));
  const actions = { ...(!every && { on: pack.actions.when }), ...Object.fromEntries(lists) };
  return Object.keys(actions).length ? actions : undefined;
}

function fileLabels(pack: CheckPack): Record<string, string> | undefined {
  const changed = VERDICTS.flatMap((verdict) => (pack.labels[verdict] === VERDICT_LABELS[verdict] ? [] : [[verdict, pack.labels[verdict]]]));
  return changed.length ? Object.fromEntries(changed) : undefined;
}

/**
 * The schema 3 file for the pack a stored policy runs as, and each thing it holds that the file cannot. `extended` says
 * the stored policy extends a workspace policy, whose rules and steps the file then holds itself.
 */
export function exportPolicyFile(pack: CheckPack, extended: boolean): PolicyFileExport {
  const unexpressed: string[] = [];
  if (extended) unexpressed.push("Later changes to the workspace's shared rules stop reaching this repository.");
  const rules = [...CATALOG_IDS.flatMap((id) => catalogRule(pack, id, unexpressed)), ...pack.custom.flatMap((row) => customRule(row, unexpressed))];
  const actions = fileActions(pack);
  const labels = fileLabels(pack);
  const body = { ...(pack.groups && { groups: pack.groups }), rules, ...(actions && { actions }), ...(labels && { labels }) };
  return { text: `# Corbits Triage policy.\n${stringify(body, { lineWidth: 0, aliasDuplicateObjects: false })}`, unexpressed };
}

/** JSON with object keys sorted, so equal values compare equal whatever order their keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sorted(values: readonly unknown[] | undefined): string[] | undefined {
  return values && values.map(canonical).sort();
}

// Merging waits for CI unless CI green is written down and switched off, so that row is not the same as no row.
const CI_SKIPPED = "Merges need not wait for CI";

/** What a built-in rule checks; undefined when it is off and its being off changes nothing. */
function catalogChecks(pack: CheckPack, id: CatalogId): string | undefined {
  const row = pack.checks[id];
  if (id === "ci-green" && row?.enabled === false) return CI_SKIPPED;
  if (!row?.enabled) return undefined;
  const conventional = id === "conventional-commits" && { types: sorted(row.types ?? CONVENTIONAL_TYPES), fields: row.fields ?? CONVENTIONAL_FIELDS };
  return canonical({ max: isSizeRule(id) ? row[SIZE_RULES[id]] : undefined, tracker: row.tracker ?? "either", paths: sorted(row.forbiddenGlobs), hotFileFixes: row.hotFileFixes, migrations: sorted(row.migrationGlobs), groups: row.sensitiveGroups, medium: row.medium, high: row.high, failAt: row.failAt, labelAt: row.labelAt, onFail: onFailText(pack, id), ...conventional });
}

function modelAsks(row: ModelCustomCheck): Record<string, unknown> {
  switch (row.shape) {
    case "is-true":
      return { claim: row.claim, scope: row.scope ?? "pull-request", when: sorted(row.when) };
    case "score":
      return { subject: row.subject, levels: row.levels, failBelow: row.failBelow };
    case "choose":
      return { options: row.options, failOn: sorted(row.failOn) };
  }
}

function customChecks(pack: CheckPack, row: CustomCheck | undefined): string | undefined {
  if (!row || row.enabled === false) return undefined;
  const onFail = onFailText(pack, row.id);
  if (row.kind === "text") return canonical({ kind: row.kind, fields: row.fields, failWhen: row.failWhen, phrases: sorted(row.phrases), onFail });
  if (row.kind === "code-patterns") return canonical({ kind: row.kind, presets: sorted(row.presets), patterns: row.patterns, onFail });
  return canonical({ kind: row.kind, shape: row.shape, ...modelAsks(row), onFail });
}

/** A step as it runs: who or what it is for is a set, so its order is not a difference; its place in the list is. */
function stepRuns(step: Step): string {
  if (!step.when) return canonical(step);
  return canonical({ ...step, when: { ...step.when, author: sorted(step.when.author), ci: sorted(step.when.ci) } });
}

const STEP_WORDS: Record<Step["do"], string> = {
  approve: "approve",
  merge: "merge",
  close: "close",
  comment: "comment",
  "request-changes": "request changes",
  "request-review": "request review",
  assign: "assign",
  labels: "add labels",
  nothing: "do nothing",
};

const CATALOG_RULES: Partial<Record<CatalogId, string>> = {
  "max-files-changed": "Most files changed",
  "max-lines-changed": "Most lines changed",
  "max-lines-changed-per-file": "Most lines changed in one file",
  "max-additions": "Most lines added",
  "max-deletions": "Most lines deleted",
  "linked-issue": "Require a linked issue from",
  "no-forbidden-paths": "Never accept changes to",
  "conventional-commits": "Conventional commits",
};

// CI green has three states: required, absent (merges still wait for CI) and written off (merges skip it).
const CI_STATES = { [CI_SKIPPED]: "merges skip CI", absent: "merges wait for CI" } as const;

/** What a switched-on rule does when it fails, unless it fails the pull request. */
export function onFailText(pack: CheckPack, id: string): string | undefined {
  const label = labelRules(pack).get(id);
  if (label !== undefined) return `on fail, labels ${label}`;
  return askRules(pack).includes(id) ? "on fail, asks a maintainer" : undefined;
}

function onFailWords(pack: CheckPack, id: string): string[] {
  const text = onFailText(pack, id);
  return text === undefined ? [] : [text];
}

function catalogValues(pack: CheckPack, id: CatalogId): string[] {
  const values = catalogLimits(pack, id);
  return values.length ? [...values, ...onFailWords(pack, id)] : values;
}

function catalogLimits(pack: CheckPack, id: CatalogId): string[] {
  const row = pack.checks[id];
  if (id === "ci-green" && row?.enabled === false) return [CI_STATES[CI_SKIPPED]];
  if (id === "ci-green" && !row?.enabled) return [CI_STATES.absent];
  if (!row?.enabled) return [];
  if (isSizeRule(id)) return [count(row[SIZE_RULES[id]])];
  switch (id) {
    case "linked-issue":
      return [ISSUE_TRACKER_NAMES[row.tracker && row.tracker !== "off" ? row.tracker : "either"]];
    case "no-forbidden-paths":
      return row.forbiddenGlobs ?? [];
    case "conventional-commits":
    case "regression-risk":
    case "sensitive-paths":
    case "risk":
      return [catalogSentence(id, pack)];
    default:
      return ["on"];
  }
}

function count(value: number | undefined): string {
  return value === undefined ? "no limit" : value.toLocaleString("en-US");
}

function listed(values: readonly string[]): string {
  return values.join(", ");
}

/** What using the file changes, after "Use the file instead". */
function instead(rule: string, saved: readonly string[], file: readonly string[]): string {
  if (file.length === 0) return `${rule} will be off.`;
  if (saved.length === 0) return `${rule} will be ${listed(file)}.`;
  return `${rule}: ${listed(file)} instead of ${listed(saved)}.`;
}

function pathsInstead(saved: readonly string[], file: readonly string[]): string {
  const freed = saved.filter((path) => !file.includes(path));
  const barred = file.filter((path) => !saved.includes(path));
  return [
    ...(freed.length ? [`Pull requests that change ${listed(freed)} will no longer fail.`] : []),
    ...(barred.length ? [`Pull requests that change ${listed(barred)} will fail.`] : []),
  ].join(" ");
}

function ciInstead(file: CheckPack): string {
  const checks = catalogChecks(file, "ci-green");
  if (checks === CI_SKIPPED) return "Merges will no longer wait for CI.";
  return checks === undefined ? "Failing CI will no longer fail pull requests; merges still wait for it." : "Pull requests with failing CI will fail.";
}

function catalogInstead(id: CatalogId, rule: string, saved: readonly string[], file: readonly string[], filePack: CheckPack): string {
  if (id === "no-forbidden-paths") return pathsInstead(saved, file);
  return id === "ci-green" ? ciInstead(filePack) : instead(rule, saved, file);
}

function catalogDifferences(saved: CheckPack, file: CheckPack): PolicyDifference[] {
  return CATALOG_IDS.flatMap(function differs(id) {
    if (catalogChecks(saved, id) === catalogChecks(file, id)) return [];
    const rule = CATALOG_RULES[id] ?? catalogSentence(id, saved);
    const [inSaved, inFile] = [catalogValues(saved, id), catalogValues(file, id)];
    return [{ rule, saved: inSaved, file: inFile, instead: catalogInstead(id, rule, inSaved, inFile, file) }];
  });
}

function customDifferences(saved: CheckPack, file: CheckPack): PolicyDifference[] {
  const ids = [...new Set([...saved.custom, ...file.custom].map((row) => row.id))];
  return ids.flatMap(function differs(id) {
    const [savedRow, fileRow] = [saved.custom.find((row) => row.id === id), file.custom.find((row) => row.id === id)];
    if (customChecks(saved, savedRow) === customChecks(file, fileRow)) return [];
    const rule = (savedRow ?? fileRow)!.name;
    const inSaved = customChecks(saved, savedRow) ? [customSentence(savedRow!), ...onFailWords(saved, id)] : [];
    const inFile = customChecks(file, fileRow) ? [customSentence(fileRow!), ...onFailWords(file, id)] : [];
    return [{ rule, saved: inSaved, file: inFile, instead: inFile.length && inSaved.length ? `${rule} will check something different.` : instead(rule, inSaved, inFile) }];
  });
}

const VERDICT_RULES: Record<VerdictWord, string> = { pass: "When it passes", fail: "When it fails", unsure: "When Triage is unsure" };

/** Whom a review request or assignment goes to, in words. */
export function people(target: PeopleTarget): string {
  switch (target.to) {
    case "codeowners":
      return "code owners";
    case "author":
      return "the author";
    case "users":
      return target.users.map((user) => `@${user}`).join(", ");
    case "teams":
      return target.teams.map((team) => `@${team}`).join(", ");
  }
}

/** What a step acts on, after its action word. */
function targetWords(step: Step): string {
  switch (step.do) {
    case "labels":
      return step.target.from === "rules" ? " for each failed rule" : ` ${step.target.labels.join(", ")}`;
    case "assign":
      return ` to ${people(step.target)}`;
    case "request-review":
      return ` from ${people(step.target)}`;
    case "comment":
      return ` "${step.target.body}"`;
    default:
      return "";
  }
}

/** An author group as words: its name, or the people or team it names. */
function authorWords(group: string | AuthorMatch): string {
  if (typeof group === "string") return group;
  if ("users" in group) return group.users.map((user) => `@${user}`).join(", ");
  if ("team" in group) return `@${group.team}`;
  return group.group;
}

/** A step as its words: the action, what it acts on, and whom it is for. */
function stepWords(step: Step): string {
  const author = step.when?.author;
  const words = `${STEP_WORDS[step.do]}${targetWords(step)}`;
  return author?.length ? `${words} for ${authorGroups(author).map(authorWords).join(", ")}` : words;
}

function actionDifferences(saved: CheckPack, file: CheckPack): PolicyDifference[] {
  const out: PolicyDifference[] = [];
  if (canonical(saved.actions.when) !== canonical(file.actions.when)) {
    out.push({ rule: "Act when a pull request is", saved: saved.actions.when, file: file.actions.when, instead: `Triage will act when a pull request is ${listed(file.actions.when)}.` });
  }
  for (const verdict of VERDICTS) {
    const [inSaved, inFile] = [saved.actions[verdict], file.actions[verdict]];
    if (canonical(inSaved.map(stepRuns)) === canonical(inFile.map(stepRuns))) continue;
    const [savedWords, fileWords] = [inSaved.map(stepWords), inFile.map(stepWords)];
    const does = fileWords.length ? fileWords.join(", then ") : "do nothing";
    out.push({ rule: VERDICT_RULES[verdict], saved: savedWords, file: fileWords, instead: `${VERDICT_RULES[verdict]}, Triage will ${does}.` });
  }
  for (const verdict of VERDICTS) {
    if (saved.labels[verdict] === file.labels[verdict]) continue;
    const rule = `The ${VERDICT_NAMES[verdict]} label`;
    out.push({ rule, saved: [saved.labels[verdict]], file: [file.labels[verdict]], instead: instead(rule, [saved.labels[verdict]], [file.labels[verdict]]) });
  }
  return out;
}

/** Who a group is, as words. */
function groupWords(group: FileGroup | undefined): string[] {
  if (!group) return [];
  return [...(group.association ?? []), ...(group.teams ?? []).map((team) => `@${team}`), ...(group.users ?? []).map((user) => `@${user}`)];
}

/** Groups match first match wins, so their order is a difference as well as who each one is. */
function groupDifferences(saved: CheckPack, file: CheckPack): PolicyDifference[] {
  const [inSaved, inFile] = [saved.groups ?? {}, file.groups ?? {}];
  const names = [...new Set([...Object.keys(inSaved), ...Object.keys(inFile)])];
  const out = names.flatMap((name): PolicyDifference[] => {
    if (canonical(inSaved[name]) === canonical(inFile[name])) return [];
    const rule = `The group ${name}`;
    const [was, is] = [groupWords(inSaved[name]), groupWords(inFile[name])];
    return [{ rule, saved: was, file: is, instead: instead(rule, was, is) }];
  });
  const [savedOrder, fileOrder] = [Object.keys(inSaved).filter((name) => Object.hasOwn(inFile, name)), Object.keys(inFile).filter((name) => Object.hasOwn(inSaved, name))];
  if (canonical(savedOrder) !== canonical(fileOrder)) {
    out.push({ rule: "The order groups are matched in", saved: savedOrder, file: fileOrder, instead: `Triage will match groups in the order ${listed(fileOrder)}.` });
  }
  return out;
}

/** Each way the file's policy runs differently from the saved one; none when they run the same. */
export function policyDifferences(saved: CheckPack, file: CheckPack): PolicyDifference[] {
  return [...catalogDifferences(saved, file), ...customDifferences(saved, file), ...groupDifferences(saved, file), ...actionDifferences(saved, file)];
}
