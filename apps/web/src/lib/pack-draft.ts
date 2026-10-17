import {
  CATALOG_IDS,
  catalogCheckEnabled,
  customCheckEnabled,
  customRuleId,
  defaultActions,
  emptyPack,
  LABEL_MAX,
  readCheckPack,
  RECOMMENDED_ISSUE,
  RECOMMENDED_PATHS,
  RECOMMENDED_SIZE,
  teamSlug,
  VERDICTS,
  type CatalogCheck,
  type CatalogId,
  type CheckPack,
  type CustomCheck,
  type Step,
  type PolicyActions,
  type RepoPolicy,
  type VerdictWord,
} from "@corbits/triage-contracts";

export type DraftPolicy = Pick<RepoPolicy, "enabled">;

/**
 * Everything the repository panel edits, as the contracts store it. `stepIds` names each verdict's steps by position,
 * so a step keeps its identity across edits, saves and a merge with another writer's pack.
 */
export type RepoDraft = {
  pack: CheckPack;
  policy: DraftPolicy;
  stepIds: Record<VerdictWord, string[]>;
  /** The id a rule was added under, by its id now, once a first save named it from its text; it keys the row on screen. */
  ruleKeys?: Record<string, string>;
};

export type StepEntry = { id: string; step: Step };

let lastStepId = 0;

export function freshStepId(): string {
  lastStepId += 1;
  return `step-${lastStepId}`;
}

function freshStepIds(pack: CheckPack): Record<VerdictWord, string[]> {
  return { pass: pack.actions.pass.map(freshStepId), fail: pack.actions.fail.map(freshStepId), unsure: pack.actions.unsure.map(freshStepId) };
}

type DraftWhere =
  | { section: "actions"; list?: VerdictWord }
  | { section: "custom"; id?: string }
  | { section: "pack" };

export type DraftProblem = { reason: string; where: DraftWhere };

export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]));
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => same(left[key], right[key]));
}

export function fromPack(pack: CheckPack, policy: DraftPolicy): RepoDraft {
  const { enabled } = policy;
  return { pack, policy: { enabled }, stepIds: freshStepIds(pack) };
}

export function toPack(draft: RepoDraft): CheckPack {
  return readCheckPack(draft.pack);
}

function withPack(draft: RepoDraft, pack: Partial<CheckPack>): RepoDraft {
  return { ...draft, pack: { ...draft.pack, ...pack } };
}

/** What a catalog check the pack lacks reads as, switched off; switching it on writes these values. */
const CATALOG_DEFAULTS: Partial<Record<CatalogId, Partial<CatalogCheck>>> = {
  "max-files-changed": { maxFiles: RECOMMENDED_SIZE.maxFiles },
  "max-lines-changed": { maxLines: RECOMMENDED_SIZE.maxLines },
  "linked-issue": RECOMMENDED_ISSUE,
  "no-forbidden-paths": { forbiddenGlobs: [...RECOMMENDED_PATHS.forbiddenGlobs] },
};

/**
 * Writes only the keys that differ, so a stored row never gains values the user did not set.
 * A check the saved pack lacks goes back to absent once it reads as absent again.
 */
export function setCatalogCheck(draft: RepoDraft, saved: CheckPack, id: CatalogId, row: Partial<CatalogCheck>): RepoDraft {
  const absent: CatalogCheck = { enabled: false, ...CATALOG_DEFAULTS[id] };
  const current = draft.pack.checks[id];
  const base = current ?? absent;
  const changed = Object.entries(row).filter(([key, value]) => value !== undefined && !same(base[key as keyof CatalogCheck], value));
  const next: CatalogCheck = { ...base, ...Object.fromEntries(changed) };
  if (!saved.checks[id] && same(next, absent)) {
    return current ? withPack(draft, { checks: Object.fromEntries(Object.entries(draft.pack.checks).filter(([key]) => key !== id)) }) : draft;
  }
  if (current && changed.length === 0) return draft;
  return withPack(draft, { checks: { ...draft.pack.checks, [id]: next } });
}

/** So two rows never share a key. */
export function freshRuleId(draft: RepoDraft, name: string): string {
  return customRuleId(name, [...draft.pack.custom.map((row) => row.id), ...Object.values(draft.ruleKeys ?? {})]);
}

/** A renamed rule keeps the key it was shown under. */
export function renamedRuleKeys(ruleKeys: Record<string, string> | undefined, renamed: Record<string, string>): Record<string, string> {
  const next = { ...ruleKeys };
  for (const [from, to] of Object.entries(renamed)) next[to] = ruleKeys?.[from] ?? from;
  return next;
}

export function stepEntries(draft: RepoDraft, list: VerdictWord): StepEntry[] {
  return draft.pack.actions[list].map((step, i) => ({ id: draft.stepIds[list][i]!, step }));
}

export function setSteps(draft: RepoDraft, list: VerdictWord, entries: StepEntry[]): RepoDraft {
  const actions: PolicyActions = { ...draft.pack.actions, [list]: entries.map((entry) => entry.step) };
  return { ...draft, pack: { ...draft.pack, actions }, stepIds: { ...draft.stepIds, [list]: entries.map((entry) => entry.id) } };
}

function changedIds<T extends { id: string }>(saved: T[], draft: T[]): number {
  const ids = new Set([...saved, ...draft].map((row) => row.id));
  return [...ids].filter((id) => !same(saved.find((row) => row.id === id), draft.find((row) => row.id === id))).length;
}

export function packChanges(saved: CheckPack, draft: CheckPack): number {
  return CATALOG_IDS.filter((id) => !same(saved.checks[id], draft.checks[id])).length
    + changedIds(saved.custom, draft.custom)
    + (["when", ...VERDICTS] as const).filter((key) => !same(saved.actions[key], draft.actions[key])).length
    + VERDICTS.filter((verdict) => saved.labels[verdict] !== draft.labels[verdict]).length;
}

export function policyChanges(saved: DraftPolicy, draft: DraftPolicy): number {
  return Number(saved.enabled !== draft.enabled);
}

function longestFirst(a: [string, string], b: [string, string]): number {
  return b[0].length - a[0].length;
}

function idAt(message: string, label: string, rows: Array<{ id: string }>): string | undefined {
  const prefixes = rows.flatMap((row, i): Array<[string, string]> => [[`${label} ${row.id} `, row.id], [`${label} ${i + 1} `, row.id]]);
  return prefixes.sort(longestFirst).find(([prefix]) => message.startsWith(prefix))?.[1];
}

function whereOf(message: string, pack: CheckPack): DraftWhere {
  const list = VERDICTS.find((word) => message.toLowerCase().startsWith(`${word} step `));
  if (list !== undefined) return { section: "actions", list };
  if (message.startsWith("Actions")) return { section: "actions" };
  const custom = idAt(message, "Custom rule", pack.custom);
  if (custom !== undefined) return { section: "custom", id: custom };
  if (message.startsWith("Custom rule ") || message.startsWith("Policy must have at most")) return { section: "custom" };
  return { section: "pack" };
}

function contractProblem(raw: unknown): string | null {
  try {
    readCheckPack(raw);
    return null;
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    return cause.message;
  }
}

/** The most steps a verdict holds, as the contract enforces. */
const STEPS_MAX = 20;

function stepProblem(draft: RepoDraft, list: VerdictWord, step: Step, position: number): string | null {
  if (position >= STEPS_MAX) return `A verdict holds at most ${STEPS_MAX} steps.`;
  const found = contractProblem({ ...emptyPack(draft.pack.repo), actions: { ...defaultActions(), [list]: [step] } });
  if (found) return found;
  // GitHub resolves a team only inside the repository's own organization.
  const authorTeams = (step.when?.author ?? []).flatMap((match) => (typeof match === "object" && "team" in match ? [match.team] : []));
  const teams = [...authorTeams, ...("target" in step && "teams" in step.target ? step.target.teams : [])];
  const outside = teams.find((team) => teamSlug(team, draft.pack.repo) === null);
  return outside === undefined ? null : `Team ${outside} is not in ${draft.pack.repo.split("/", 1)[0]}.`;
}

/** A label as the contract stores it: runs of whitespace and control characters become one space. */
export function storedLabel(name: string): string {
  return name.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
}

function labelProblem(name: string): string | null {
  const stored = storedLabel(name);
  if (!stored) return "name the label.";
  return stored.length > LABEL_MAX ? `a label is at most ${LABEL_MAX} characters.` : null;
}

function customProblem(draft: RepoDraft, row: CustomCheck): string | null {
  return contractProblem({ ...emptyPack(draft.pack.repo), custom: [row] });
}

function catalogReadable(pack: CheckPack, id: CatalogId, row: CatalogCheck): boolean {
  const counts = [row.maxFiles, row.maxLines].every((count) => count === undefined || (Number.isInteger(count) && count >= 1));
  return counts && contractProblem({ ...emptyPack(pack.repo), checks: { [id]: row } }) === null;
}

/** The saved step under each id, or the step itself when it can be saved; a new unfinished step waits. The same step twice is written once, as the contract runs it once. */
function savableSteps(draft: RepoDraft, saved: RepoDraft, list: VerdictWord): StepEntry[] {
  const before = new Map(stepEntries(saved, list).map((entry) => [entry.id, entry.step]));
  const seen = new Set<string>();
  return stepEntries(draft, list).flatMap(function written(entry, position): StepEntry[] {
    const step = stepProblem(draft, list, entry.step, position) === null ? entry.step : before.get(entry.id);
    if (!step) return [];
    const key = storedStepKey(draft.pack.repo, list, step);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: entry.id, step }];
  });
}

/** A step as the contract stores it, so steps that differ only in what the contract trims compare equal. */
export function storedStepKey(repo: string, list: VerdictWord, step: Step): string {
  return storedKey({ ...emptyPack(repo), actions: { ...defaultActions(), [list]: [step] } }, (pack) => pack.actions[list], step);
}

/** A rule as the contract stores it, so rules that differ only in what the contract trims compare equal. */
export function storedRuleKey(repo: string, row: CustomCheck): string {
  return storedKey({ ...emptyPack(repo), custom: [row] }, (pack) => pack.custom, row);
}

export function storedCatalogKey(repo: string, id: CatalogId, row: CatalogCheck | undefined): string {
  return row === undefined ? "absent" : storedKey({ ...emptyPack(repo), checks: { [id]: row } }, (pack) => pack.checks[id], row);
}

/** One row read through the contract, as text to compare; a row the contract cannot read yet compares as typed. */
function storedKey(raw: unknown, pick: (pack: CheckPack) => unknown, typed: unknown): string {
  try {
    return JSON.stringify(pick(readCheckPack(raw)));
  } catch {
    return JSON.stringify(typed);
  }
}

/**
 * What of the draft can be saved now. A step or rule mid-edit keeps its saved version until it can be saved again, a new
 * one waits in the draft until it is filled, and a built-in rule mid-edit keeps its saved value, so one half-typed row
 * never holds back or loses the rest.
 */
export function savable(draft: RepoDraft, saved: RepoDraft): RepoDraft {
  const pack = draft.pack;
  const checks = Object.fromEntries(CATALOG_IDS.flatMap(function kept(id) {
    const row = pack.checks[id];
    const value = row && catalogReadable(pack, id, row) ? row : saved.pack.checks[id];
    return value ? [[id, value]] : [];
  }));
  const custom = pack.custom.flatMap(function written(row) {
    if (customProblem(draft, row) === null) return [row];
    return saved.pack.custom.filter((stored) => stored.id === row.id);
  });
  const labels = Object.fromEntries(VERDICTS.map((verdict) => [verdict, labelProblem(pack.labels[verdict]) === null ? pack.labels[verdict] : saved.pack.labels[verdict]])) as CheckPack["labels"];
  let result: RepoDraft = { ...draft, pack: { ...pack, checks, custom, labels } };
  for (const list of VERDICTS) result = setSteps(result, list, savableSteps(draft, saved, list));
  return result;
}

export function validate(draft: RepoDraft, saved: RepoDraft): DraftProblem | null {
  try {
    toPack(savable(draft, saved));
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    return { reason: cause.message, where: whereOf(cause.message, draft.pack) };
  }
  return null;
}

/** Whether any rule is switched on; triage runs without one, but triggers nothing. */
export function hasRuleOn(pack: CheckPack): boolean {
  return CATALOG_IDS.some((id) => catalogCheckEnabled(pack, id)) || pack.custom.some(customCheckEnabled);
}
