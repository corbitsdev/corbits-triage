import { CATALOG_IDS, customCheckEnabled, customRuleId, readCheckPack, type CatalogCheck, type CatalogId, type CheckPack, type CustomCheck, type ModelCheck, type RuleCheck } from "@corbits/triage-contracts";
import { errorText } from "./error-text.ts";
import { defaultLocalPack } from "./local-pack.ts";
import { CATALOG_ORDER } from "./prose.ts";

export function isCatalogId(id: string): id is CatalogId {
  return (CATALOG_IDS as readonly string[]).includes(id);
}

/** A change the pack contract refuses, with its reason in the contract's own words. */
export type Refusal = { reason: string };

function validated(candidate: CheckPack): CheckPack | Refusal {
  try {
    return readCheckPack(candidate, candidate.repo);
  } catch (cause) {
    return { reason: errorText(cause) };
  }
}

/** A catalog check is switched by its row's flag, a custom check by its own, which is stored only as false. */
export function withCheck(pack: CheckPack, id: string, on: boolean): CheckPack {
  if (isCatalogId(id)) {
    const defaults = defaultLocalPack(pack.repo);
    return readCheckPack({ ...pack, checks: { ...pack.checks, [id]: { ...(pack.checks[id] ?? defaults.checks[id]), enabled: on } } }, pack.repo);
  }
  function toggled(row: CustomCheck): CustomCheck {
    if (row.id !== id) return row;
    const { enabled: _was, ...rest } = row;
    return (on ? rest : { ...rest, enabled: false }) as CustomCheck;
  }
  return readCheckPack({ ...pack, custom: pack.custom.map(toggled) }, pack.repo);
}

export function withoutCheck(pack: CheckPack, id: string): CheckPack {
  return readCheckPack({ ...pack, custom: pack.custom.filter((c) => c.id !== id) }, pack.repo);
}

/** A catalog check's limits merged into its row, which keeps the default's values for the rest. */
export function withCatalogParams(pack: CheckPack, id: CatalogId, params: Partial<Omit<CatalogCheck, "enabled">>): CheckPack | Refusal {
  const row = pack.checks[id] ?? defaultLocalPack(pack.repo).checks[id] ?? { enabled: false };
  return validated({ ...pack, checks: { ...pack.checks, [id]: { ...row, ...params } } });
}

/** A custom check as the editor holds it: a name and its rule's or shape's parameters. */
export type CustomForm = { name: string } & (({ kind: "rule" } & RuleCheck) | ({ kind: "model" } & ModelCheck));

/** Unique over the pack's and the defaults' ids, so a new rule never takes a default's id while that default is removed. */
function nextCustomId(pack: CheckPack, name: string): string {
  return customRuleId(name, [...pack.custom, ...defaultLocalPack(pack.repo).custom].map((check) => check.id));
}

/** Adds a custom check, or replaces check `id` in place keeping its group and switch; the reason is the contract's. */
export function withCustomCheck(pack: CheckPack, form: CustomForm, id?: string): { pack: CheckPack; id: string } | Refusal {
  const existing = id === undefined ? undefined : pack.custom.find((check) => check.id === id);
  const checkId = existing?.id ?? nextCustomId(pack, form.name);
  const check = { ...form, id: checkId, group: existing?.group ?? "pull-request", ...(existing?.enabled === false && { enabled: false }) } as CustomCheck;
  const custom = existing ? pack.custom.map((row) => (row.id === checkId ? check : row)) : [...pack.custom, check];
  const next = validated({ ...pack, custom });
  return "reason" in next ? next : { pack: next, id: checkId };
}

export function customFormOf(check: CustomCheck): CustomForm {
  const { id: _id, group: _group, enabled: _enabled, ...form } = check;
  return form as CustomForm;
}

/** Every check in the manager: the catalog in the portal's order, then the repository's custom checks. */
export function switchableChecks(pack: CheckPack): Array<{ id: string; on: boolean }> {
  const catalog = CATALOG_ORDER.map((id) => ({ id, on: pack.checks[id]?.enabled === true }));
  const custom = pack.custom.map((check) => ({ id: check.id, on: customCheckEnabled(check) }));
  return [...catalog, ...custom];
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

/** Extension storage does not keep key order, so rows compare by content. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a, sortedKeys) === JSON.stringify(b, sortedKeys);
}

/** How many checks differ from the defaults: switched, limits changed, added or removed. */
export function changesFromDefaults(pack: CheckPack): number {
  const defaults = defaultLocalPack(pack.repo);
  const catalog = CATALOG_IDS.filter((id) => !same(pack.checks[id] ?? null, defaults.checks[id] ?? null)).length;
  function sameRule(a: CustomCheck, b: CustomCheck): boolean {
    return same({ ...a, id: "" }, { ...b, id: "" });
  }
  // A default saved under the id it had before rules were renamed matches by content.
  function counterpart(row: CustomCheck, rows: CustomCheck[]): CustomCheck | undefined {
    return rows.find((c) => c.id === row.id) ?? rows.find((c) => sameRule(c, row));
  }
  const changed = pack.custom.filter((row) => {
    const match = counterpart(row, defaults.custom);
    return !match || !sameRule(match, row);
  }).length;
  const removed = defaults.custom.filter((row) => !counterpart(row, pack.custom)).length;
  return catalog + changed + removed;
}
