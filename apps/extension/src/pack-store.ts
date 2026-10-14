import { CHECK_PACK_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION, readCheckPack, STEP_KINDS, VERDICTS, type CheckPack } from "@corbits/triage-contracts";
import { errorText } from "./error-text.ts";
import { defaultLocalPack } from "./local-pack.ts";
import { localPacks } from "./storage.ts";

type StoredDo = { kind?: unknown; target?: Record<string, unknown> };

/** A version 1 Do as a step for anyone; a kind that no longer runs is left out. */
function stepOf({ kind, target }: StoredDo): unknown[] {
  if (!(STEP_KINDS as readonly unknown[]).includes(kind)) return [];
  return [target && Object.keys(target).length > 0 ? { do: kind, target } : { do: kind }];
}

/** Version 1 local packs held their lists as Dos, which this reads as steps so a person's edits survive. */
function stepsOf(actions: unknown): unknown {
  if (typeof actions !== "object" || actions === null || Array.isArray(actions)) return actions;
  const lists = actions as Record<string, unknown>;
  return { ...lists, ...Object.fromEntries(VERDICTS.map((verdict) => [verdict, Array.isArray(lists[verdict]) ? (lists[verdict] as StoredDo[]).flatMap(stepOf) : lists[verdict]])) };
}

/**
 * A stored pack, or why it does not read. Earlier versions' defaults held custom rules over GitHub data, which no
 * longer run, so they are left out rather than costing a person every other edit.
 */
export function readLocalPack(stored: unknown, repo: string): { pack: CheckPack } | { error: string } {
  const row = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : undefined;
  const custom = Array.isArray(row?.custom) ? row.custom.filter((check) => (check as { kind?: unknown } | null)?.kind !== "rule") : row?.custom;
  const upgraded = row?.schemaVersion === LEGACY_SCHEMA_VERSION ? { schemaVersion: CHECK_PACK_SCHEMA_VERSION, actions: stepsOf(row.actions) } : {};
  try {
    return { pack: readCheckPack(row ? { ...row, custom, ...upgraded } : stored, repo) };
  } catch (cause) {
    return { error: errorText(cause) };
  }
}

/** A stored pack that does not read falls back to the default rather than running half a pack; Settings says why. */
export async function localPackFor(repo: string): Promise<CheckPack> {
  const stored = (await localPacks.getValue())[repo];
  const read = stored === undefined ? undefined : readLocalPack(stored, repo);
  return read && "pack" in read ? read.pack : defaultLocalPack(repo);
}

export async function saveLocalPack(pack: CheckPack): Promise<void> {
  const all = await localPacks.getValue();
  await localPacks.setValue({ ...all, [pack.repo]: pack });
}

export async function resetLocalPack(repo: string): Promise<void> {
  const { [repo]: _dropped, ...rest } = await localPacks.getValue();
  await localPacks.setValue(rest);
}
