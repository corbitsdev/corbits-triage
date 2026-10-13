import {
  BUILT_IN_CHECK_NAMES,
  CATALOG_IDS,
  catalogCheckEnabled,
  customCheckEnabled,
  defaultActions,
  emptyPack,
  isCatalogId,
  readCheckPack,
  RECOMMENDED_ISSUE,
  RECOMMENDED_PATHS,
  RECOMMENDED_SIZE,
  VERDICTS,
  type CatalogCheck,
  type CatalogId,
  type CheckPack,
  type CheckRef,
  type CustomCheck,
  type Step,
  type PolicyActions,
  type RepoPolicy,
  type VerdictWord,
} from "@corbits/triage-contracts";

export type DraftPolicy = Pick<RepoPolicy, "enabled">;

/** Everything the repository panel edits, as the contracts store it. */
export type RepoDraft = { pack: CheckPack; policy: DraftPolicy };

/** Where in the panel a validation reason belongs. */
type DraftWhere =
  | { section: "actions"; list?: VerdictWord }
  | { section: "custom"; id?: string }
  | { section: "triage" }
  | { section: "pack" };

export type DraftProblem = { reason: string; where: DraftWhere };

function same(a: unknown, b: unknown): boolean {
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
  return { pack, policy: { enabled } };
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

/** A catalog check's value as stored, or the default it reads as. */
export function catalogValue<K extends keyof CatalogCheck>(pack: CheckPack, id: CatalogId, key: K): CatalogCheck[K] {
  return pack.checks[id]?.[key] ?? CATALOG_DEFAULTS[id]?.[key] as CatalogCheck[K];
}

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

/** Whether a check is in the verdict; a saved tracker of "off" leaves the issue check doing nothing, so it reads as off. */
export function checkOn(pack: CheckPack, id: CheckRef): boolean {
  if (BUILT_IN_CHECK_NAMES.has(id)) return true;
  if (!isCatalogId(id)) return pack.custom.some((row) => row.id === id && customCheckEnabled(row));
  return catalogCheckEnabled(pack, id) && !(id === "linked-issue" && pack.checks["linked-issue"]?.tracker === "off");
}

/** Off is stored as `enabled: false`; back on drops the flag, which the contract reads as on. */
export function setCustomEnabled(draft: RepoDraft, id: string, enabled: boolean): RepoDraft {
  function toggled(row: CustomCheck): CustomCheck {
    if (row.id !== id) return row;
    const { enabled: _was, ...rest } = row;
    return (enabled ? rest : { ...rest, enabled: false }) as CustomCheck;
  }
  return withPack(draft, { custom: draft.pack.custom.map(toggled) });
}

export function removeCustom(draft: RepoDraft, id: string): RepoDraft {
  return withPack(draft, { custom: draft.pack.custom.filter((row) => row.id !== id) });
}

function withActions(draft: RepoDraft, actions: Partial<PolicyActions>): RepoDraft {
  return withPack(draft, { actions: { ...draft.pack.actions, ...actions } });
}

export function setList(draft: RepoDraft, list: VerdictWord, steps: Step[]): RepoDraft {
  return withActions(draft, { [list]: steps });
}

function changedIds<T extends { id: string }>(saved: T[], draft: T[]): number {
  const ids = new Set([...saved, ...draft].map((row) => row.id));
  return [...ids].filter((id) => !same(saved.find((row) => row.id === id), draft.find((row) => row.id === id))).length;
}

/** One change per catalog check and custom check that differs, plus one each for the policy's when and each verdict list that differs. */
export function packChanges(saved: CheckPack, draft: CheckPack): number {
  return CATALOG_IDS.filter((id) => !same(saved.checks[id], draft.checks[id])).length
    + changedIds(saved.custom, draft.custom)
    + (["when", ...VERDICTS] as const).filter((key) => !same(saved.actions[key], draft.actions[key])).length;
}

/** One change when the triage switch differs. */
export function policyChanges(saved: DraftPolicy, draft: DraftPolicy): number {
  return Number(saved.enabled !== draft.enabled);
}

function longestFirst(a: [string, string], b: [string, string]): number {
  return b[0].length - a[0].length;
}

/** The id whose `<label> <id>` or `<label> <position>` prefix the message starts with. */
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

/** Why one step cannot be saved yet, in the contract's words; null when it can. */
export function stepProblem(draft: RepoDraft, list: VerdictWord, step: Step): string | null {
  return contractProblem({ ...emptyPack(draft.pack.repo), actions: { ...defaultActions(), [list]: [step] } });
}

/** Why one custom rule cannot be saved yet, in the contract's words; null when it can. */
export function customProblem(draft: RepoDraft, row: CustomCheck): string | null {
  return contractProblem({ ...emptyPack(draft.pack.repo), custom: [row] });
}

function catalogReadable(pack: CheckPack, id: CatalogId, row: CatalogCheck): boolean {
  const counts = [row.maxFiles, row.maxLines].every((count) => count === undefined || (Number.isInteger(count) && count >= 1));
  return counts && contractProblem({ ...emptyPack(pack.repo), checks: { [id]: row } }) === null;
}

/**
 * What of the draft can be saved now: an unfinished step or rule waits in the draft until it is filled, and a built-in
 * rule mid-edit keeps its saved value, so one half-typed row never holds back the rest.
 */
export function savable(draft: RepoDraft, saved: CheckPack): RepoDraft {
  const pack = draft.pack;
  const checks = Object.fromEntries(CATALOG_IDS.flatMap((id) => {
    const row = pack.checks[id];
    const kept = row && catalogReadable(pack, id, row) ? row : saved.checks[id];
    return kept ? [[id, kept]] : [];
  }));
  const lists = Object.fromEntries(VERDICTS.map((list) => [list, pack.actions[list].filter((step) => stepProblem(draft, list, step) === null)]));
  const custom = pack.custom.filter((row) => customProblem(draft, row) === null);
  return { ...draft, pack: { ...pack, checks, custom, actions: { ...pack.actions, ...lists } } };
}

/** Why what can be saved still cannot be, in the contract's words, and where that belongs; null when it can. */
export function validate(draft: RepoDraft, saved: CheckPack): DraftProblem | null {
  let pack: CheckPack;
  try {
    pack = toPack(savable(draft, saved));
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    return { reason: cause.message, where: whereOf(cause.message, draft.pack) };
  }
  const anyCheck = CATALOG_IDS.some((id) => catalogCheckEnabled(pack, id)) || pack.custom.some(customCheckEnabled);
  if (draft.policy.enabled && !anyCheck) return { reason: "Switch on a rule before turning triage on.", where: { section: "triage" } };
  return null;
}
