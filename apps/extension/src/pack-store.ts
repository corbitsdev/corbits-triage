import { errorText } from "@corbits/common";
import { readCheckPack, recommendedPack, type CheckPack } from "@corbits/triage-contracts";
import { localPacks } from "./storage.ts";

export function readLocalPack(stored: unknown, repo: string): { pack: CheckPack } | { error: string } {
  try {
    return { pack: readCheckPack(stored, repo) };
  } catch (cause) {
    return { error: errorText(cause) };
  }
}

/** The rules saved in this browser for a repository, or the recommended ones while none are saved. */
export async function savedPackFor(repo: string): Promise<CheckPack> {
  const stored = (await localPacks.getValue())[repo];
  if (stored === undefined) return recommendedPack(repo);
  const read = readLocalPack(stored, repo);
  if ("error" in read) throw new Error(`The rules saved for ${repo} do not read (${read.error}). Reset them in the side panel.`);
  return read.pack;
}

export async function saveLocalPack(pack: CheckPack): Promise<void> {
  const all = await localPacks.getValue();
  await localPacks.setValue({ ...all, [pack.repo]: pack });
}

export async function resetLocalPack(repo: string): Promise<void> {
  const { [repo]: _dropped, ...rest } = await localPacks.getValue();
  await localPacks.setValue(rest);
}
