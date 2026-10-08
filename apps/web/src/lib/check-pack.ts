import { ApiError, type Transport } from "@intx/hub-client";
import {
  applyRecommended,
  checkPackName,
  emptyPack,
  parseCheckPack,
  recommendedPack,
  type CheckPack,
  type CleanupMode,
} from "@corbits/triage-contracts";
import { CONFIG_KEY, findArtifactByTitle, patchAppConfig, validateRepo } from "./hub-api.ts";

export {
  applyRecommended,
  checkPackName,
  emptyPack,
  recommendedPack,
  type CheckPack,
};

type ArtifactListItem = { id: string; title: string; kind?: string };
type ArtifactDetail = ArtifactListItem & { content?: string; version?: number };

function enc(value: string): string {
  return encodeURIComponent(value);
}

function collection(tenantId: string): string {
  return `/api/tenants/${enc(tenantId)}/artifacts`;
}

async function findByTitle(transport: Transport, tenantId: string, title: string): Promise<ArtifactListItem | null> {
  const page = await transport.fetch<{ artifacts?: ArtifactListItem[] }>(
    "GET",
    `${collection(tenantId)}?query=${enc(title)}&limit=100`,
  );
  const rows = Array.isArray(page?.artifacts) ? page.artifacts : [];
  return rows.find((row) => row.title === title) ?? null;
}

/** True when the repository's check pack artifact exists; the config pointer can be lost when a sync re-adds a repository row. */
export async function hasCheckPack(transport: Transport, tenantId: string, repo: string): Promise<boolean> {
  return (await findArtifactByTitle(transport, tenantId, checkPackName(repo))) !== null;
}

const MAX_INDEX_PAGES = 50;

/** Every check pack's artifact id by title, from one listing of the tenant's check-pack artifacts. */
export async function listCheckPackIds(transport: Transport, tenantId: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const prefix = "check-pack/";
  let cursor: string | null = null;
  for (let page = 0; page < MAX_INDEX_PAGES; page += 1) {
    const listed: { artifacts?: ArtifactListItem[]; nextCursor?: string | null } = await transport.fetch(
      "GET",
      `${collection(tenantId)}?query=${enc(prefix)}&limit=100${cursor ? `&cursor=${enc(cursor)}` : ""}`,
    );
    for (const row of Array.isArray(listed?.artifacts) ? listed.artifacts : []) {
      if (row.title.startsWith(prefix)) ids[row.title] = row.id;
    }
    const next = listed?.nextCursor ?? null;
    if (!next || next === cursor) return ids;
    cursor = next;
  }
  throw new Error("The hub paginated check packs past its page limit.");
}

export async function loadCheckPackById(transport: Transport, tenantId: string, repo: string, id: string): Promise<CheckPack | null> {
  const detail = await transport.fetch<{ artifact?: ArtifactDetail }>("GET", `${collection(tenantId)}/${enc(id)}`);
  return parseCheckPack(detail?.artifact?.content, validateRepo(repo));
}

export async function saveCheckPack(
  transport: Transport,
  tenantId: string,
  repo: string,
  pack: CheckPack,
  extras?: { cleanupMode?: CleanupMode },
): Promise<CheckPack> {
  const clean = validateRepo(repo);
  const parsed = parseCheckPack(pack, clean);
  if (!parsed) throw new Error("Check pack is not valid.");
  const title = checkPackName(clean);
  const content = JSON.stringify(parsed);
  const listed = await findByTitle(transport, tenantId, title);
  if (!listed) {
    try {
      await transport.fetch("POST", collection(tenantId), {
        mode: "text",
        title,
        content,
        metadata: { checkPack: title },
      });
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    }
  } else {
    await transport.fetch("POST", `${collection(tenantId)}/${enc(listed.id)}/versions`, { content, title });
  }
  function linkPack(row: unknown): unknown {
    if (!row || typeof row !== "object" || (row as { name?: unknown }).name !== clean) return row;
    return {
      ...row,
      checkPack: { name: title },
      ...(extras?.cleanupMode ? { cleanupMode: extras.cleanupMode } : {}),
    };
  }
  await patchAppConfig(transport, tenantId, function linkRepoPack(current) {
    return { ...current, repos: (current.repos ?? []).map(linkPack) };
  });
  return parsed;
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
