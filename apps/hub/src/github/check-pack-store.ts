// SPDX-License-Identifier: GPL-2.0-only
import { findArtifactByTitle, getArtifact, type ArtifactDb } from "@corbits/artifacts";
import { checkPackName, parseCheckPack, type CheckPack } from "@corbits/triage-contracts";

export type CheckPackRead = { status: "ok"; pack: CheckPack } | { status: "missing" } | { status: "corrupt" };

export async function loadCheckPack(db: ArtifactDb, tenantId: string, repo: string): Promise<CheckPackRead> {
  let title: string;
  try {
    title = checkPackName(repo);
  } catch {
    return { status: "missing" };
  }
  const found = await findArtifactByTitle(db, tenantId, title);
  if (!found) return { status: "missing" };
  const row = await getArtifact(db, found.artifactId);
  if (!row) return { status: "missing" };
  const pack = parseCheckPack(row.content, repo);
  return pack ? { status: "ok", pack } : { status: "corrupt" };
}
