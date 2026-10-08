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
import { CONFIG_KEY, findArtifactByTitle, loadRepoCheckPack, patchAppConfig, validateRepo } from "./hub-api.ts";

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

/** True when the repository's check pack artifact exists; the config pointer can be lost when a sync re-adds a repository row. */
export async function hasCheckPack(transport: Transport, tenantId: string, repo: string): Promise<boolean> {
  return (await findArtifactByTitle(transport, tenantId, checkPackName(repo))) !== null;
}

export async function loadCheckPack(transport: Transport, tenantId: string, repo: string): Promise<CheckPack | null> {
  return loadRepoCheckPack(transport, tenantId, validateRepo(repo));
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
  const listed = await findArtifactByTitle(transport, tenantId, title);
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
