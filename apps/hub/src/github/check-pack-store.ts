import { findArtifactByTitle, getArtifact, type ArtifactDb } from "@corbits/artifacts";
import { checkPackName, readCheckPack, type CheckPack } from "@corbits/triage-contracts";

export type CheckPackRead = { status: "ok"; pack: CheckPack } | { status: "missing" } | { status: "corrupt"; reason: string };

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
  try {
    return { status: "ok", pack: readCheckPack(row.content, repo) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { status: "corrupt", reason: error.message };
  }
}
