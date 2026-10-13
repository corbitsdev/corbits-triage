import { findArtifactByTitle, getArtifact, type ArtifactDb } from "@corbits/artifacts";
import { checkPackName, readCheckPack, type ActionKind, type CheckPack } from "@corbits/triage-contracts";

/** `automatic` is the Do kinds the pr-triage role is granted on the repository. */
export type StoredPack = { pack: CheckPack; automatic: ActionKind[] };

export type CheckPackRead = ({ status: "ok" } & StoredPack) | { status: "missing" } | { status: "corrupt"; reason: string };

export async function loadCheckPack(
  db: ArtifactDb,
  tenantId: string,
  repo: string,
  automaticKinds: (tenantId: string, repo: string) => Promise<ActionKind[]>,
): Promise<CheckPackRead> {
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
  let pack: CheckPack;
  try {
    pack = readCheckPack(row.content, repo);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { status: "corrupt", reason: error.message };
  }
  return { status: "ok", pack, automatic: await automaticKinds(tenantId, repo) };
}
