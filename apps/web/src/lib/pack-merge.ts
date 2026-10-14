import { CATALOG_IDS, CHECK_CATALOG, customRuleId, VERDICTS, type CatalogCheck, type CatalogId, type CheckPack, type CustomCheck, type Step, type VerdictWord } from "@corbits/triage-contracts";
import { freshStepId, renamedRuleKeys, same, setSteps, stepEntries, storedCatalogKey, storedLabel, storedRuleKey, storedStepKey, type RepoDraft, type StepEntry } from "./pack-draft.ts";

type Keyed<T> = { id: string; value: T };

/** A row as the contract stores it, so a change only in what the contract trims is not a change. */
type Stored<T> = (value: T) => string;

const VERDICT_NAMES: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };

export type Merged = { draft: RepoDraft; conflicts: string[] };

/**
 * Our changes since `base`, applied onto `theirs`. A row only one side changed takes that side; a row both changed
 * takes ours and is named in `both`; a row we removed goes unless they changed it; a row they removed comes back only
 * if we changed it; rows we added follow theirs.
 */
function mergeKeyed<T>(base: Keyed<T>[], ours: Keyed<T>[], theirs: Keyed<T>[], stored: Stored<T>): { rows: Keyed<T>[]; both: string[] } {
  const before = new Map(base.map((row) => [row.id, stored(row.value)]));
  const mine = new Map(ours.map((row) => [row.id, row.value]));
  const kept = new Set(theirs.map((row) => row.id));
  const both: string[] = [];
  const merged = theirs.flatMap(function mergedRow(row): Array<Keyed<T>> {
    const original = before.get(row.id);
    if (original === undefined) return [row];
    const theyChanged = stored(row.value) !== original;
    if (!mine.has(row.id)) return theyChanged ? [row] : [];
    const value = mine.get(row.id)!;
    if (stored(value) === original) return [row];
    if (theyChanged && stored(value) !== stored(row.value)) both.push(row.id);
    return [{ id: row.id, value }];
  });
  const revived = ours.filter((row) => before.has(row.id) && !kept.has(row.id) && stored(row.value) !== before.get(row.id));
  const added = ours.filter((row) => !before.has(row.id));
  return { rows: [...merged, ...revived, ...added], both };
}

/**
 * Their steps under the ids of the base steps they still hold unchanged. A step they changed or added gets an id of its
 * own, so it merges as their removal plus their addition and never takes the place of a step this panel edited.
 */
function theirEntries(repo: string, list: VerdictWord, base: StepEntry[], steps: Step[]): StepEntry[] {
  const unused = base.map((entry) => ({ id: entry.id, key: storedStepKey(repo, list, entry.step) }));
  return steps.map(function entryOf(step): StepEntry {
    const key = storedStepKey(repo, list, step);
    const at = unused.findIndex((entry) => entry.key === key);
    return at < 0 ? { id: freshStepId(), step } : { id: unused.splice(at, 1)[0]!.id, step };
  });
}

export function rekeyed(base: RepoDraft, theirs: RepoDraft): RepoDraft {
  let keyed = theirs;
  for (const list of VERDICTS) keyed = setSteps(keyed, list, theirEntries(theirs.pack.repo, list, stepEntries(base, list), theirs.pack.actions[list]));
  return keyed;
}

function keyedSteps(entries: StepEntry[]): Keyed<Step>[] {
  return entries.map((entry) => ({ id: entry.id, value: entry.step }));
}

/** Both sides adding the same step keeps one copy, as the contract runs it once. */
function mergedSteps(base: RepoDraft, ours: RepoDraft, theirs: RepoDraft, list: VerdictWord): StepEntry[] {
  const repo = theirs.pack.repo;
  const stored = (step: Step) => storedStepKey(repo, list, step);
  const { rows } = mergeKeyed(keyedSteps(stepEntries(base, list)), keyedSteps(stepEntries(ours, list)), keyedSteps(stepEntries(theirs, list)), stored);
  const seen = new Set<string>();
  return rows.flatMap(function once(row): StepEntry[] {
    const key = stored(row.value);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: row.id, step: row.value }];
  });
}

function keyedRules(rows: CustomCheck[]): Keyed<CustomCheck>[] {
  return rows.map((row) => ({ id: row.id, value: row }));
}

/**
 * Rules merged by id. A rule we added under an id they took since gets an id of its own; `renamed` maps the ids that
 * changed, and `both` names the rules both sides changed.
 */
function mergedCustom(base: CheckPack, ours: CheckPack, theirs: CheckPack): { rows: CustomCheck[]; renamed: Record<string, string>; both: string[] } {
  const stored = (row: CustomCheck) => storedRuleKey(theirs.repo, row);
  const merged = mergeKeyed(keyedRules(base.custom), keyedRules(ours.custom), keyedRules(theirs.custom), stored);
  const rows = merged.rows.map((row) => row.value);
  const theirIds = new Set(theirs.custom.map((row) => row.id));
  const baseIds = new Set(base.custom.map((row) => row.id));
  const taken = rows.map((row) => row.id);
  const renamed: Record<string, string> = {};
  const owned = rows.map(function own(row) {
    if (baseIds.has(row.id) || !theirIds.has(row.id) || theirs.custom.includes(row)) return row;
    const id = customRuleId(row.name, taken);
    taken.push(id);
    renamed[row.id] = id;
    return { ...row, id };
  });
  const both = merged.both.map((id) => ours.custom.find((row) => row.id === id)?.name ?? id);
  return { rows: owned, renamed, both };
}

/** A built-in rule merged key by key, so their switch-off and our limit both stay; `both` when both changed one key. */
function mergedCatalog(repo: string, id: CatalogId, base: CatalogCheck | undefined, ours: CatalogCheck | undefined, theirs: CatalogCheck | undefined): { row: CatalogCheck | undefined; both: boolean } {
  const stored = (row: CatalogCheck | undefined) => storedCatalogKey(repo, id, row);
  if (stored(ours) === stored(base)) return { row: theirs, both: false };
  if (stored(theirs) === stored(base)) return { row: ours, both: false };
  if (!ours || !theirs || !base) return { row: ours, both: stored(ours) !== stored(theirs) };
  const row: Record<string, unknown> = { ...theirs };
  let both = false;
  for (const key of new Set([...Object.keys(ours), ...Object.keys(base)]) as Set<keyof CatalogCheck>) {
    if (same(ours[key], base[key])) continue;
    if (!same(theirs[key], base[key]) && !same(theirs[key], ours[key])) both = true;
    if (ours[key] === undefined) delete row[key];
    else row[key] = ours[key];
  }
  return { row: row as CatalogCheck, both };
}

function pick<T>(mine: T, original: T, other: T, stored: (value: T) => unknown = (value) => value): { value: T; both: boolean } {
  if (same(stored(mine), stored(original))) return { value: other, both: false };
  return { value: mine, both: !same(stored(other), stored(original)) && !same(stored(other), stored(mine)) };
}

let lastRuleKey = 0;

export function mergeDrafts(base: RepoDraft, ours: RepoDraft, theirs: RepoDraft): Merged {
  const repo = theirs.pack.repo;
  const conflicts: string[] = [];
  const checks = Object.fromEntries(CATALOG_IDS.flatMap(function check(id) {
    const merged = mergedCatalog(repo, id, base.pack.checks[id], ours.pack.checks[id], theirs.pack.checks[id]);
    if (merged.both) conflicts.push(CHECK_CATALOG[id].name);
    return merged.row ? [[id, merged.row]] : [];
  }));
  const custom = mergedCustom(base.pack, ours.pack, theirs.pack);
  conflicts.push(...custom.both);
  const labels = Object.fromEntries(VERDICTS.map(function label(verdict) {
    const merged = pick(ours.pack.labels[verdict], base.pack.labels[verdict], theirs.pack.labels[verdict], storedLabel);
    if (merged.both) conflicts.push(`the ${VERDICT_NAMES[verdict]} label`);
    return [verdict, merged.value];
  })) as CheckPack["labels"];
  const when = pick(ours.pack.actions.when, base.pack.actions.when, theirs.pack.actions.when);
  if (when.both) conflicts.push("the events the steps run on");
  const enabled = pick(ours.policy.enabled, base.policy.enabled, theirs.policy.enabled);
  if (enabled.both) conflicts.push("the triage switch");
  const pack: CheckPack = { ...theirs.pack, checks, custom: custom.rows, labels, actions: { ...theirs.pack.actions, when: when.value } };
  const ruleKeys = renamedRuleKeys(ours.ruleKeys, custom.renamed);
  // Their rule now holds an id one of ours was shown under, so it is shown under a key of its own.
  for (const from of Object.keys(custom.renamed).filter((id) => pack.custom.some((row) => row.id === id))) {
    lastRuleKey += 1;
    ruleKeys[from] = `${from}~${lastRuleKey}`;
  }
  let draft: RepoDraft = { pack, policy: { enabled: enabled.value }, stepIds: theirs.stepIds, ruleKeys };
  for (const list of VERDICTS) draft = setSteps(draft, list, mergedSteps(base, ours, theirs, list));
  return { draft, conflicts };
}
