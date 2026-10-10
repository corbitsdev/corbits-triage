import { applyRecommended, CATALOG_IDS, catalogCheckEnabled, type CheckPack } from "@corbits/triage-contracts";
import { checkPackFromDraft, draftFromCheckPack, type DraftPack } from "./check-catalog.ts";

/** Everything the repository panel edits: the check pack with its posting mode, and the repository's triage switches. */
export type RepoDraft = { pack: DraftPack; enabled: boolean; triageDrafts: boolean };

function builtPack(pack: DraftPack): CheckPack | null {
  try {
    return checkPackFromDraft(pack);
  } catch {
    return null;
  }
}

function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** Changed checks, counted the way the pack stores them, so the files and lines limits are one change. */
export function checkChanges(saved: DraftPack, draft: DraftPack): number {
  const before = builtPack(saved);
  const after = builtPack(draft);
  if (!before || !after) return 1;
  const ids = new Set([...Object.keys(before.checks), ...Object.keys(after.checks)]) as Set<keyof CheckPack["checks"]>;
  const customIds = new Set([...before.custom, ...after.custom].map((row) => row.id));
  function customDiffers(id: string): boolean {
    return differs(before!.custom.find((row) => row.id === id), after!.custom.find((row) => row.id === id));
  }
  return [...ids].filter((id) => differs(before.checks[id], after.checks[id])).length + [...customIds].filter(customDiffers).length;
}

export function unsavedChanges(saved: RepoDraft, draft: RepoDraft): number {
  return checkChanges(saved.pack, draft.pack)
    + Number(saved.pack.mode !== draft.pack.mode)
    + Number(saved.enabled !== draft.enabled)
    + Number(saved.triageDrafts !== draft.triageDrafts);
}

/** Catalog checks switched on, as the repositories table counts them; null when the draft does not build. */
export function catalogChecksOn(pack: DraftPack): number | null {
  const built = builtPack(pack);
  return built ? CATALOG_IDS.filter((id) => catalogCheckEnabled(built, id)).length : null;
}

/** Every own is-true check needs its instruction; the pack drops one without it. */
export function hasBlankCustomCheck(pack: DraftPack): boolean {
  return pack.custom.some((row) => !row.typed && !(row.instruction ?? "").trim());
}

/** Whether the draft keeps at least one check, which triage needs before it can be switched on. */
export function hasAnyCheck(pack: DraftPack): boolean {
  return pack.checks.some((row) => row.enabled) || pack.custom.length > 0;
}

/** The recommended checks, keeping the repository's own checks and posting mode. */
export function recommendedDraft(pack: DraftPack): DraftPack {
  return draftFromCheckPack(applyRecommended(checkPackFromDraft(pack)), pack.mode);
}
