import { readCheckPack, type CheckPack } from "@corbits/triage-contracts";
import { errorText } from "./error-text.ts";
import { defaultLocalPack } from "./local-pack.ts";
import { localPacks } from "./storage.ts";

/**
 * A stored pack, or why it does not read. Earlier versions' defaults held custom rules over GitHub data, which no
 * longer run, so they are left out rather than costing a person every other edit.
 */
export function readLocalPack(stored: unknown, repo: string): { pack: CheckPack } | { error: string } {
  const row = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : undefined;
  const custom = Array.isArray(row?.custom) ? row.custom.filter((check) => (check as { kind?: unknown } | null)?.kind !== "rule") : row?.custom;
  try {
    return { pack: readCheckPack(row ? { ...row, custom } : stored, repo) };
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
