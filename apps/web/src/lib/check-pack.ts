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
import { CONFIG_KEY, patchAppConfig, validateRepo } from "./hub-api.ts";

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

export async function loadCheckPack(transport: Transport, tenantId: string, repo: string): Promise<CheckPack | null> {
  const clean = validateRepo(repo);
  const title = checkPackName(clean);
  const listed = await findByTitle(transport, tenantId, title);
  if (!listed) return null;
  const detail = await transport.fetch<{ artifact?: ArtifactDetail }>("GET", `${collection(tenantId)}/${enc(listed.id)}`);
  return parseCheckPack(detail?.artifact?.content, clean);
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
