import { ApiError, type Transport } from "@intx/hub-client";
import {
  CHECK_PACK_TITLE_PREFIX,
  checkPackName,
  readCheckPack,
  type CheckPack,
} from "@corbits/triage-contracts";
import { enc, findArtifactByTitle, listArtifacts, loadRepoCheckPack, newestByTitle, validateRepo, type ArtifactListItem, type StoredCheckPack } from "./hub-api.ts";

function collection(tenantId: string): string {
  return `/api/tenants/${enc(tenantId)}/artifacts`;
}

export async function listCheckPacks(transport: Transport, tenantId: string): Promise<Map<string, ArtifactListItem>> {
  const rows = await listArtifacts(transport, tenantId, CHECK_PACK_TITLE_PREFIX);
  return newestByTitle(rows.filter((row) => row.title.startsWith(CHECK_PACK_TITLE_PREFIX)));
}

export class StaleCheckPackError extends Error {
  constructor() {
    super("This policy changed since you opened it. Reload to see the latest.");
  }
}

export type LoadedCheckPack = Pick<StoredCheckPack, "id" | "version">;

function versionOf(body: { version?: number } | undefined, what: string): number {
  if (typeof body?.version !== "number") throw new Error(`The hub ${what} the policy without returning its version.`);
  return body.version;
}

/** Editing a policy that extends a workspace policy is not built yet, so a save would replace the override with a whole pack. */
export class ExtendedPolicyError extends Error {
  constructor() {
    super("This repository's policy extends a workspace policy and cannot be edited here yet.");
  }
}

/** Versions the artifact the draft was loaded from while triage still reads it; `expectedVersion` refuses it when anyone wrote since. */
async function versionCheckPack(transport: Transport, tenantId: string, repo: string, content: string, loaded: LoadedCheckPack): Promise<number> {
  const current = await loadRepoCheckPack(transport, tenantId, repo);
  if ((current?.kind !== "pack" && current?.kind !== "corrupt") || current.id !== loaded.id) throw new StaleCheckPackError();
  if (current.kind === "pack" && current.shared) throw new ExtendedPolicyError();
  const title = checkPackName(repo);
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
 * same moment can both succeed; each save then pins its artifact on the
 * repository's record, and the last pin is the policy triage reads.
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
  if (typeof id !== "string") throw new Error("The hub created the policy without returning its id.");
  return { id, version: versionOf(created.artifact, "created") };
}

/** Writes the draft onto the artifact it was loaded from, or creates one when the form saw none; never over a pack it did not see. */
export async function writeCheckPack(transport: Transport, tenantId: string, repo: string, pack: CheckPack, loaded: LoadedCheckPack | null): Promise<StoredCheckPack> {
  const clean = validateRepo(repo);
  const parsed = readCheckPack(pack, clean);
  const title = checkPackName(clean);
  const content = JSON.stringify(parsed);
  const stored = loaded
    ? { id: loaded.id, version: await versionCheckPack(transport, tenantId, clean, content, loaded) }
    : await createCheckPack(transport, tenantId, title, content);
  return { kind: "pack", ...stored, pack: parsed };
}
