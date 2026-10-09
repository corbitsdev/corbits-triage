import { ApiError, type Transport } from "@intx/hub-client";
import {
  CHECK_PACK_TITLE_PREFIX,
  applyRecommended,
  checkPackName,
  emptyPack,
  parseCheckPack,
  recommendedPack,
  type CheckPack,
  type CleanupMode,
} from "@corbits/triage-contracts";
import { CONFIG_KEY, findArtifactByTitle, listArtifacts, patchAppConfig, validateRepo, type StoredCheckPack } from "./hub-api.ts";

export {
  applyRecommended,
  checkPackName,
  emptyPack,
  recommendedPack,
  type CheckPack,
};

function enc(value: string): string {
  return encodeURIComponent(value);
}

function collection(tenantId: string): string {
  return `/api/tenants/${enc(tenantId)}/artifacts`;
}

/** Every check pack title the tenant has, from one listing of its check-pack artifacts. */
export async function listCheckPackTitles(transport: Transport, tenantId: string): Promise<Set<string>> {
  const rows = await listArtifacts(transport, tenantId, CHECK_PACK_TITLE_PREFIX);
  return new Set(rows.map((row) => row.title).filter((title) => title.startsWith(CHECK_PACK_TITLE_PREFIX)));
}

export class StaleCheckPackError extends Error {
  constructor() {
    super("This check pack changed since you opened it. Reload to see the latest.");
  }
}

/** The artifact a draft was read from. */
export type LoadedCheckPack = Pick<StoredCheckPack, "id" | "version">;

function versionOf(body: { version?: number } | undefined, what: string): number {
  if (typeof body?.version !== "number") throw new Error(`The hub ${what} the check pack without returning its version.`);
  return body.version;
}

async function versionCheckPack(transport: Transport, tenantId: string, title: string, content: string, loaded: LoadedCheckPack): Promise<number> {
  const newest = await findArtifactByTitle(transport, tenantId, title);
  if (newest?.id !== loaded.id) throw new StaleCheckPackError();
  try {
    const revised = await transport.fetch<{ version?: number }>("POST", `${collection(tenantId)}/${enc(loaded.id)}/versions`, {
      content,
      title,
      expectedVersion: loaded.version,
    });
    return versionOf(revised, "versioned");
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) throw new StaleCheckPackError();
    throw cause;
  }
}

/**
 * The stock artifact route has no title uniqueness, so two first saves at the
 * same moment can both succeed; the newest wins, and the loser's next save is
 * refused as stale because its artifact no longer resolves for the title.
 */
async function createCheckPack(transport: Transport, tenantId: string, title: string, content: string): Promise<LoadedCheckPack> {
  if (await findArtifactByTitle(transport, tenantId, title)) throw new StaleCheckPackError();
  const created = await transport.fetch<{ artifact?: { id?: string; version?: number } }>("POST", collection(tenantId), {
    mode: "text",
    title,
    content,
    metadata: { checkPack: title },
  });
  const id = created?.artifact?.id;
  if (typeof id !== "string") throw new Error("The hub created the check pack without returning its id.");
  return { id, version: versionOf(created.artifact, "created") };
}

/** Writes the draft onto the artifact it was loaded from, or creates one when the form saw none; never over a pack it did not see. */
export async function saveCheckPack(
  transport: Transport,
  tenantId: string,
  repo: string,
  pack: CheckPack,
  options: { cleanupMode?: CleanupMode; loaded: LoadedCheckPack | null },
): Promise<StoredCheckPack> {
  const clean = validateRepo(repo);
  const parsed = parseCheckPack(pack, clean);
  if (!parsed) throw new Error("Check pack is not valid.");
  const title = checkPackName(clean);
  const content = JSON.stringify(parsed);
  const stored = options.loaded
    ? { id: options.loaded.id, version: await versionCheckPack(transport, tenantId, title, content, options.loaded) }
    : await createCheckPack(transport, tenantId, title, content);
  function linkPack(row: unknown): unknown {
    if (!row || typeof row !== "object" || (row as { name?: unknown }).name !== clean) return row;
    return {
      ...row,
      checkPack: { name: title },
      ...(options.cleanupMode ? { cleanupMode: options.cleanupMode } : {}),
    };
  }
  await patchAppConfig(transport, tenantId, function linkRepoPack(current) {
    return { ...current, repos: (current.repos ?? []).map(linkPack) };
  });
  return { kind: "pack", ...stored, pack: parsed };
}

export function customizeDraft(repo: string): CheckPack {
  return emptyPack(repo);
}

export function recommendedDraft(repo: string): CheckPack {
  return recommendedPack(repo);
}

export function repoNeedsCheckSetup(repo: { checkPack?: { name?: string } } | null | undefined): boolean {
  return !(repo?.checkPack?.name?.trim());
}

export { CONFIG_KEY };
