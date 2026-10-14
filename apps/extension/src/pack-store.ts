import { readCheckPack, type CheckPack } from "@corbits/triage-contracts";
import { errorText } from "./error-text.ts";
import { defaultLocalPack } from "./local-pack.ts";
import { localPacks } from "./storage.ts";

export function readLocalPack(stored: unknown, repo: string): { pack: CheckPack } | { error: string } {
  try {
    return { pack: readCheckPack(stored, repo) };
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
