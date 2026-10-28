// A policy written as a schema 3 policy file, as the starter policy is, and the words the portal reads a policy back in.
import { stringify } from "yaml";
import {
  askRules,
  AUTHOR_GROUPS,
  CATALOG_IDS,
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
  type OnFail,
  type PeopleTarget,
  type Step,
  type VerdictWord,
} from "./check-pack.js";
import { ruleNameOf } from "./policy-rules.js";
import { catalogSentence } from "./rule-prose.js";

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

/** The schema 3 file for `pack`, and each thing it holds that the file cannot. */
export function exportPolicyFile(pack: CheckPack): PolicyFileExport {
  const unexpressed: string[] = [];
  const rules = [...CATALOG_IDS.flatMap((id) => catalogRule(pack, id, unexpressed)), ...pack.custom.flatMap((row) => customRule(row, unexpressed))];
  const actions = fileActions(pack);
  const labels = fileLabels(pack);
  const body = { ...(pack.groups && { groups: pack.groups }), rules, ...(actions && { actions }), ...(labels && { labels }) };
  return { text: `# Corbits Triage policy.\n${stringify(body, { lineWidth: 0, aliasDuplicateObjects: false })}`, unexpressed };
}

/** What a switched-on rule does when it fails, unless it fails the pull request. */
export function onFailText(pack: CheckPack, id: string): string | undefined {
  const label = labelRules(pack).get(id);
  if (label !== undefined) return `on fail, labels ${label}`;
  return askRules(pack).includes(id) ? "on fail, asks a maintainer" : undefined;
}

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
