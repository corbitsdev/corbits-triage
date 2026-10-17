// A stored policy written as a schema 3 policy file, and what two policies do differently. Both read the pack triage
// runs on, so a rule's wording, reason and evidence never count as a difference; what it checks and every step do.
import { dump, JSON_SCHEMA } from "js-yaml";
import {
  AUTHOR_GROUPS,
  CATALOG_IDS,
  POLICY_EVENTS,
  VERDICT_LABELS,
  VERDICTS,
  type AuthorMatch,
  type CatalogCheck,
  type CatalogId,
  type CheckPack,
  type CustomCheck,
  type ModelCustomCheck,
  type Step,
  type VerdictWord,
} from "./check-pack.js";
import { ruleNameOf } from "./policy-rules.js";
import { catalogSentence, customSentence } from "./rule-prose.js";

const REASON = "Set in the portal before the policy file.";
const EVIDENCE = ["maintainer-stated"];
const VERDICT_NAMES: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };

export type PolicyFileExport = { text: string; unexpressed: string[] };

/** A rule as the file writes it: its sentence, what it checks, then why it exists. */
function written(row: { reason?: string; evidence?: string[]; enabled?: boolean }, head: Record<string, unknown>, text: string, checks: Record<string, unknown>) {
  return { ...head, text, ...checks, reason: row.reason ?? REASON, evidence: row.evidence ?? EVIDENCE, ...(row.enabled === false && { enabled: false }) };
}

/** A built-in rule's parameters as schema 3 writes them; undefined when it has none it requires. */
function catalogParams(id: CatalogId, row: CatalogCheck): Record<string, unknown> | undefined {
  switch (id) {
    case "max-files-changed":
      return row.maxFiles === undefined ? undefined : { max: row.maxFiles };
    case "max-lines-changed":
      return row.maxLines === undefined ? undefined : { max: row.maxLines };
    case "linked-issue":
      if (row.tracker === "off") return undefined;
      return row.tracker === undefined ? {} : { tracker: row.tracker };
    case "no-forbidden-paths":
      return row.forbiddenGlobs?.length ? { paths: row.forbiddenGlobs } : undefined;
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
    if (row.enabled) unexpressed.push(`"${catalogSentence(id, pack)}" is on without a value a policy file can hold, so the file leaves it out.`);
    return [];
  }
  return [written(row, { check: id }, row.text ?? `${catalogSentence(id, pack)}.`, params)];
}

function customRule(row: CustomCheck, unexpressed: string[]): Record<string, unknown>[] {
  if (row.name !== ruleNameOf(row.id)) unexpressed.push(`Rule "${row.name}" is named "${ruleNameOf(row.id)}" in the file.`);
  if (row.kind === "text") {
    return [written(row, { id: row.id, check: "text" }, row.text ?? row.name, { fields: row.fields, failWhen: row.failWhen, phrases: row.phrases })];
  }
  if (row.shape === "is-true" && row.when === undefined && (row.scope ?? "pull-request") === "pull-request") {
    return [written(row, { id: row.id, check: "model" }, row.claim, {})];
  }
  unexpressed.push(`Rule "${row.name}" (${customSentence(row)}) cannot be written in a policy file, so the file leaves it out.`);
  return [];
}

/** Author kinds a group stands for, written as the group, so the file reads as people wrote it. */
function authorGroups(author: readonly AuthorMatch[]): unknown[] {
  const out: unknown[] = [];
  for (let at = 0; at < author.length; ) {
    const group = Object.entries(AUTHOR_GROUPS).find(([, kinds]) => kinds.every((kind, i) => author[at + i] === kind));
    out.push(group ? group[0] : author[at]);
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
  if (extended) unexpressed.push("The workspace's shared rules are copied into the file, so later changes to them no longer reach this repository.");
  const rules = [...CATALOG_IDS.flatMap((id) => catalogRule(pack, id, unexpressed)), ...pack.custom.flatMap((row) => customRule(row, unexpressed))];
  const actions = fileActions(pack);
  const labels = fileLabels(pack);
  const body = { rules, ...(actions && { actions }), ...(labels && { labels }) };
  return { text: `# Corbits Triage policy.\n${dump(body, { schema: JSON_SCHEMA, lineWidth: -1, noRefs: true })}`, unexpressed };
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
  return canonical({ maxFiles: row.maxFiles, maxLines: row.maxLines, tracker: row.tracker ?? "either", paths: sorted(row.forbiddenGlobs) });
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

function customChecks(row: CustomCheck | undefined): string | undefined {
  if (!row || row.enabled === false) return undefined;
  if (row.kind === "text") return canonical({ kind: row.kind, fields: row.fields, failWhen: row.failWhen, phrases: sorted(row.phrases) });
  return canonical({ kind: row.kind, shape: row.shape, ...modelAsks(row) });
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

function thirdPerson(phrase: string): string {
  return phrase.replace(/^(\w+)/, (verb) => (verb === "do" ? "does" : `${verb}s`));
}

/** What a list of steps does, after "your saved rules" or, with `one`, after "the file". */
function stepsText(steps: readonly Step[], one: boolean): string {
  const words = steps.length ? steps.map((step) => STEP_WORDS[step.do]) : [STEP_WORDS.nothing];
  return (one ? words.map(thirdPerson) : words).join(", then ");
}

function catalogWords(pack: CheckPack, id: CatalogId, checks: string): string {
  return checks === CI_SKIPPED ? CI_SKIPPED : catalogSentence(id, pack);
}

function catalogDifferences(saved: CheckPack, file: CheckPack): string[] {
  return CATALOG_IDS.flatMap(function differs(id) {
    const [inSaved, inFile] = [catalogChecks(saved, id), catalogChecks(file, id)];
    if (inSaved === inFile) return [];
    if (inFile === undefined) return [`Your saved rules have "${catalogWords(saved, id, inSaved!)}"; the file does not.`];
    if (inSaved === undefined) return [`The file has "${catalogWords(file, id, inFile)}"; your saved rules do not.`];
    return [`Your saved rules say "${catalogWords(saved, id, inSaved)}"; the file says "${catalogWords(file, id, inFile)}".`];
  });
}

function customDifferences(saved: CheckPack, file: CheckPack): string[] {
  const ids = [...new Set([...saved.custom, ...file.custom].map((row) => row.id))];
  return ids.flatMap(function differs(id) {
    const [savedRow, fileRow] = [saved.custom.find((row) => row.id === id), file.custom.find((row) => row.id === id)];
    const [inSaved, inFile] = [customChecks(savedRow), customChecks(fileRow)];
    if (inSaved === inFile) return [];
    const name = (savedRow ?? fileRow)!.name;
    if (inFile === undefined) return [`Rule "${name}" is on in your saved rules but not in the file.`];
    if (inSaved === undefined) return [`Rule "${name}" is on in the file but not in your saved rules.`];
    return [`Rule "${name}" checks something different in the file.`];
  });
}

function actionDifferences(saved: CheckPack, file: CheckPack): string[] {
  const out: string[] = [];
  if (canonical(saved.actions.when) !== canonical(file.actions.when)) {
    out.push(`Your saved rules act when a pull request is ${saved.actions.when.join(", ")}; the file when it is ${file.actions.when.join(", ")}.`);
  }
  for (const verdict of VERDICTS) {
    const [inSaved, inFile] = [saved.actions[verdict], file.actions[verdict]];
    if (canonical(inSaved.map(stepRuns)) === canonical(inFile.map(stepRuns))) continue;
    const [savedText, fileText] = [stepsText(inSaved, false), stepsText(inFile, true)];
    out.push(stepsText(inSaved, true) === fileText
      ? `On ${VERDICT_NAMES[verdict]}, the steps are for different people or conditions.`
      : `On ${VERDICT_NAMES[verdict]}, your saved rules ${savedText}; the file ${fileText}.`);
  }
  for (const verdict of VERDICTS) {
    if (saved.labels[verdict] !== file.labels[verdict]) out.push(`The ${VERDICT_NAMES[verdict]} label is "${saved.labels[verdict]}" in your saved rules and "${file.labels[verdict]}" in the file.`);
  }
  return out;
}

/** Each way the file's policy runs differently from the saved one, in plain words; none when they run the same. */
export function policyDifferences(saved: CheckPack, file: CheckPack): string[] {
  return [...catalogDifferences(saved, file), ...customDifferences(saved, file), ...actionDifferences(saved, file)];
}
