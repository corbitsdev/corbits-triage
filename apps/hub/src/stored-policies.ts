// Policies were once kept as tenant artifacts titled `check-pack/…`; the policy file is now the only policy. They are
// archived, not migrated, so they stay restorable through the artifact package and are never read again.
import { type } from "arktype";
import { sql } from "drizzle-orm";
import { getArtifact, setArtifactArchived, type ArtifactDb } from "@corbits/artifacts";
import { CHECK_PACK_TITLE_PREFIX } from "@corbits/triage-contracts";
import type { DB } from "@intx/db";

const Standing = type({ id: "string" }).array();

/**
 * Archives every policy artifact still standing, in every tenant. After the first boot it finds none. It reads
 * `artifacts.artifact` directly because `listArtifacts` lists one tenant.
 */
export async function archiveStoredPolicies(db: DB["db"], artifacts: ArtifactDb, log: (entry: Record<string, unknown>) => void): Promise<void> {
  const standing = Standing.assert(await db.execute(sql`select id from artifacts.artifact where title like ${`${CHECK_PACK_TITLE_PREFIX}%`} and archived_at is null`));
  for (const { id } of standing) {
    const row = await getArtifact(artifacts, id);
    if (row) await setArtifactArchived(artifacts, row, true);
  }
  if (standing.length > 0) log({ level: "info", msg: "stored_policies_archived", policies: standing.length });
}
