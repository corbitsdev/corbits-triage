import {
  CATALOG_IDS,
  catalogCheckEnabled,
  packMergeThreshold,
  readCheckPack,
  RECOMMENDED_DRIFT,
  RECOMMENDED_ISSUE,
  RECOMMENDED_PATHS,
  RECOMMENDED_SIZE,
  type Action,
  type CatalogCheck,
  type CatalogId,
  type CheckPack,
  type CustomCheck,
  type Do,
  type RepoPolicy,
  type RepoRole,
} from "@corbits/triage-contracts";

export type DraftPolicy = Pick<RepoPolicy, "cleanupMode" | "enabled" | "triageDrafts" | "roles">;

/** Everything the repository panel edits, as the contracts store it. */
export type RepoDraft = { pack: CheckPack; policy: DraftPolicy };

/** Where in the panel a validation reason belongs. */
export type DraftWhere =
  | { section: "actions"; id: string }
  | { section: "custom"; id?: string }
  | { section: "triage" }
  | { section: "merge" }
  | { section: "pack" };

export type DraftProblem = { reason: string; where: DraftWhere };

export type Refused = { reason: string };

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
  const { cleanupMode, enabled, triageDrafts, roles } = policy;
  return { pack, policy: { cleanupMode, enabled, triageDrafts, roles } };
}

export function toPack(draft: RepoDraft): CheckPack {
  return readCheckPack(draft.pack);
}

function withPack(draft: RepoDraft, pack: Partial<CheckPack>): RepoDraft {
  return { ...draft, pack: { ...draft.pack, ...pack } };
}

/** What a catalog check the pack lacks reads as, switched off; switching it on writes these values. */
export const CATALOG_DEFAULTS: Partial<Record<CatalogId, Partial<CatalogCheck>>> = {
  size: RECOMMENDED_SIZE,
  issue: RECOMMENDED_ISSUE,
  drift: RECOMMENDED_DRIFT,
  paths: { forbiddenGlobs: [...RECOMMENDED_PATHS.forbiddenGlobs] },
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

function upsert<T extends { id: string }>(rows: T[], row: T): T[] {
  return rows.some((item) => item.id === row.id) ? rows.map((item) => (item.id === row.id ? row : item)) : [...rows, row];
}

export function upsertCustom(draft: RepoDraft, check: CustomCheck): RepoDraft {
  return withPack(draft, { custom: upsert(draft.pack.custom, check) });
}

/** Also drops the check from every action; refused when an action would be left with branches but no checks. */
export function removeCustom(draft: RepoDraft, id: string): RepoDraft | Refused {
  const emptied = draft.pack.actions.find((action) => action.checks.length === 1 && action.checks[0] === id);
  if (emptied) return { reason: `Action ${emptied.id} checks only ${id}. Give it another check or remove the action first.` };
  return withPack(draft, {
    custom: draft.pack.custom.filter((row) => row.id !== id),
    actions: draft.pack.actions.map((action) => (action.checks.some((ref) => ref === id) ? { ...action, checks: action.checks.filter((ref) => ref !== id) } : action)),
  });
}

/** A threshold the saved pack lacks goes back to absent once it equals the default again. */
export function setMergeThreshold(draft: RepoDraft, saved: CheckPack, value: number): RepoDraft {
  if (saved.mergeThreshold === undefined && value === packMergeThreshold(undefined)) {
    const { mergeThreshold: _dropped, ...pack } = draft.pack;
    return { ...draft, pack };
  }
  return withPack(draft, { mergeThreshold: value });
}

export function upsertAction(draft: RepoDraft, action: Action): RepoDraft {
  return withPack(draft, { actions: upsert(draft.pack.actions, action) });
}

export function removeAction(draft: RepoDraft, id: string): RepoDraft {
  return withPack(draft, { actions: draft.pack.actions.filter((action) => action.id !== id) });
}

export function moveAction(draft: RepoDraft, id: string, to: number): RepoDraft {
  const moving = draft.pack.actions.find((action) => action.id === id);
  if (!moving) return draft;
  const rest = draft.pack.actions.filter((action) => action.id !== id);
  const at = Math.max(0, Math.min(to, rest.length));
  return withPack(draft, { actions: [...rest.slice(0, at), moving, ...rest.slice(at)] });
}

export function setRole(draft: RepoDraft, name: string, role: RepoRole): RepoDraft {
  return { ...draft, policy: { ...draft.policy, roles: { ...draft.policy.roles, [name]: role } } };
}

export function removeRole(draft: RepoDraft, name: string): RepoDraft {
  const roles = Object.fromEntries(Object.entries(draft.policy.roles).filter(([key]) => key !== name));
  return { ...draft, policy: { ...draft.policy, roles } };
}

function changedIds<T extends { id: string }>(saved: T[], draft: T[]): number {
  const ids = new Set([...saved, ...draft].map((row) => row.id));
  return [...ids].filter((id) => !same(saved.find((row) => row.id === id), draft.find((row) => row.id === id))).length;
}

function reordered(saved: Action[], draft: Action[]): boolean {
  const kept = new Set(draft.map((action) => action.id));
  const before = saved.map((action) => action.id).filter((id) => kept.has(id));
  const after = draft.map((action) => action.id).filter((id) => before.includes(id));
  return !same(before, after);
}

/** One change per catalog check, custom check and action that differs, plus one each for a reorder of the actions and a new merge threshold. */
export function packChanges(saved: CheckPack, draft: CheckPack): number {
  return Number(!Object.is(saved.mergeThreshold, draft.mergeThreshold))
    + CATALOG_IDS.filter((id) => !same(saved.checks[id], draft.checks[id])).length
    + changedIds(saved.custom, draft.custom)
    + changedIds(saved.actions, draft.actions)
    + Number(reordered(saved.actions, draft.actions));
}

/** One change per policy switch and per role that differs. */
export function policyChanges(saved: DraftPolicy, draft: DraftPolicy): number {
  const roles = new Set([...Object.keys(saved.roles), ...Object.keys(draft.roles)]);
  return Number(saved.cleanupMode !== draft.cleanupMode)
    + Number(saved.enabled !== draft.enabled)
    + Number(saved.triageDrafts !== draft.triageDrafts)
    + [...roles].filter((name) => !same(saved.roles[name], draft.roles[name])).length;
}

export function changeCount(saved: RepoDraft, draft: RepoDraft): number {
  return packChanges(saved.pack, draft.pack) + policyChanges(saved.policy, draft.policy);
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
  const action = idAt(message, "Action", pack.actions);
  if (action !== undefined) return { section: "actions", id: action };
  const custom = idAt(message, "Custom check", pack.custom);
  if (custom !== undefined) return { section: "custom", id: custom };
  if (message.startsWith("Merge score threshold ")) return { section: "merge" };
  if (message.startsWith("Custom check ") || message.startsWith("Check pack must have at most")) return { section: "custom" };
  return { section: "pack" };
}

/** Role names the action's Dos assign or request review from. */
export function rolesUsed(action: Action): string[] {
  const dos: Do[] = Object.values(action.branches).flat();
  return dos.flatMap((step) => ((step.kind === "assign" || step.kind === "request-review") && step.target.to === "role" ? [step.target.role] : []));
}

function missingRole(action: Action, roles: DraftPolicy["roles"]): string | undefined {
  return rolesUsed(action).find((role) => !Object.hasOwn(roles, role));
}

/** Why the draft cannot be saved, in the contract's words, and where that belongs; null when it can. */
export function validate(draft: RepoDraft): DraftProblem | null {
  let pack: CheckPack;
  try {
    pack = toPack(draft);
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    return { reason: cause.message, where: whereOf(cause.message, draft.pack) };
  }
  for (const action of pack.actions) {
    const role = missingRole(action, draft.policy.roles);
    if (role !== undefined) return { reason: `Action ${action.id} targets role ${role}, which this repository does not define.`, where: { section: "actions", id: action.id } };
  }
  const anyCheck = CATALOG_IDS.some((id) => catalogCheckEnabled(pack, id)) || pack.custom.length > 0;
  if (draft.policy.enabled && !anyCheck) return { reason: "Switch on a check before turning triage on.", where: { section: "triage" } };
  return null;
}
