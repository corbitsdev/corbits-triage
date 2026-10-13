import { parseCheckPack, type CheckPack } from "@corbits/triage-contracts";
import { defaultLocalPack } from "./local-pack.ts";
import { localPacks } from "./storage.ts";

/** A stored pack that no longer reads as valid falls back to the default rather than running half a pack. */
export async function localPackFor(repo: string): Promise<CheckPack> {
  const stored = (await localPacks.getValue())[repo];
  return (stored && parseCheckPack(stored, repo)) ?? defaultLocalPack(repo);
}

export async function saveLocalPack(pack: CheckPack): Promise<void> {
  const all = await localPacks.getValue();
  await localPacks.setValue({ ...all, [pack.repo]: pack });
}

export async function resetLocalPack(repo: string): Promise<void> {
  const { [repo]: _dropped, ...rest } = await localPacks.getValue();
  await localPacks.setValue(rest);
}
