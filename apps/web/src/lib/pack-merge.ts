import { CATALOG_IDS, customRuleId, VERDICTS, type CheckPack, type CustomCheck, type Step, type VerdictWord } from "@corbits/triage-contracts";
import { freshStepId, same, setSteps, stepEntries, type RepoDraft, type StepEntry } from "./pack-draft.ts";

type Keyed<T> = { id: string; value: T };

/**
 * Our changes since `base`, applied onto `theirs`. A row only one side changed takes that side; a row both changed takes
 * ours; a row we removed goes unless they changed it; a row they removed comes back only if we changed it; rows we
 * added follow theirs.
 */
function mergeKeyed<T>(base: Keyed<T>[], ours: Keyed<T>[], theirs: Keyed<T>[]): Keyed<T>[] {
  const before = new Map(base.map((row) => [row.id, row.value]));
  const mine = new Map(ours.map((row) => [row.id, row.value]));
  const kept = new Set(theirs.map((row) => row.id));
  const merged = theirs.flatMap(function mergedRow(row): Array<Keyed<T>> {
    if (!before.has(row.id)) return [row];
    const original = before.get(row.id);
    if (!mine.has(row.id)) return same(row.value, original) ? [] : [row];
    const value = mine.get(row.id)!;
    return [same(value, original) ? row : { id: row.id, value }];
  });
  const revived = ours.filter((row) => before.has(row.id) && !kept.has(row.id) && !same(row.value, before.get(row.id)));
  const added = ours.filter((row) => !before.has(row.id));
  return [...merged, ...revived, ...added];
}

/** Their steps under the ids of the base steps they still match: the same step first, then the rest in order. */
function theirEntries(base: StepEntry[], steps: Step[]): StepEntry[] {
  const unused = [...base];
  const matched: Array<StepEntry | null> = steps.map(function sameStep(step) {
    const at = unused.findIndex((entry) => same(entry.step, step));
    if (at < 0) return null;
    const [entry] = unused.splice(at, 1);
    return { id: entry!.id, step };
  });
  return steps.map(function entryAt(step, i): StepEntry {
    return matched[i] ?? { id: unused.shift()?.id ?? freshStepId(), step };
  });
}

function keyedSteps(entries: StepEntry[]): Keyed<Step>[] {
  return entries.map((entry) => ({ id: entry.id, value: entry.step }));
}

function mergedSteps(base: RepoDraft, ours: RepoDraft, theirs: RepoDraft, list: VerdictWord): StepEntry[] {
  const before = stepEntries(base, list);
  const rows = mergeKeyed(keyedSteps(before), keyedSteps(stepEntries(ours, list)), keyedSteps(theirEntries(before, theirs.pack.actions[list])));
  return rows.map((row) => ({ id: row.id, step: row.value }));
}

function keyedRules(rows: CustomCheck[]): Keyed<CustomCheck>[] {
  return rows.map((row) => ({ id: row.id, value: row }));
}

/** A rule we added under an id they took since gets an id of its own. */
function mergedCustom(base: CheckPack, ours: CheckPack, theirs: CheckPack): CustomCheck[] {
  const rows = mergeKeyed(keyedRules(base.custom), keyedRules(ours.custom), keyedRules(theirs.custom)).map((row) => row.value);
  const theirIds = new Set(theirs.custom.map((row) => row.id));
  const baseIds = new Set(base.custom.map((row) => row.id));
  const taken = rows.map((row) => row.id);
  return rows.map(function own(row) {
    if (baseIds.has(row.id) || !theirIds.has(row.id) || theirs.custom.includes(row)) return row;
    const id = customRuleId(row.name, taken);
    taken.push(id);
    return { ...row, id };
  });
}

/** Ours when we changed it since `base`, otherwise theirs. */
function pick<T>(mine: T, original: T, other: T): T {
  return same(mine, original) ? other : mine;
}

/** What this panel changed since `base`, applied onto what another writer saved since (`theirs`). */
export function mergeDrafts(base: RepoDraft, ours: RepoDraft, theirs: RepoDraft): RepoDraft {
  const checks = Object.fromEntries(CATALOG_IDS.flatMap(function check(id) {
    const value = pick(ours.pack.checks[id], base.pack.checks[id], theirs.pack.checks[id]);
    return value ? [[id, value]] : [];
  }));
  const pack: CheckPack = {
    ...theirs.pack,
    checks,
    custom: mergedCustom(base.pack, ours.pack, theirs.pack),
    labels: { pass: pick(ours.pack.labels.pass, base.pack.labels.pass, theirs.pack.labels.pass), fail: pick(ours.pack.labels.fail, base.pack.labels.fail, theirs.pack.labels.fail), unsure: pick(ours.pack.labels.unsure, base.pack.labels.unsure, theirs.pack.labels.unsure) },
    actions: { ...theirs.pack.actions, when: pick(ours.pack.actions.when, base.pack.actions.when, theirs.pack.actions.when) },
  };
  let merged: RepoDraft = { pack, policy: { enabled: pick(ours.policy.enabled, base.policy.enabled, theirs.policy.enabled) }, stepIds: theirs.stepIds, ...(ours.ruleKeys && { ruleKeys: ours.ruleKeys }) };
  for (const list of VERDICTS) merged = setSteps(merged, list, mergedSteps(base, ours, theirs, list));
  return merged;
}
