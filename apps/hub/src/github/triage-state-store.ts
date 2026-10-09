// Per-repository triage state, one artifact beside the repository's check pack.
// A load hands back the version it read; a save takes that handle and is
// refused when the state moved on, so two writers never overwrite each
// other unseen. The first write is refused the same way when the artifact
// appeared since the load.
import { sql } from "drizzle-orm";
import { createArtifact, findArtifactByTitle, getArtifact, writeArtifactVersion, type ArtifactDb } from "@corbits/artifacts";
import {
  parseTriageState,
  TRIAGE_STATE_KIND,
  TRIAGE_STATE_SCHEMA_VERSION,
  triageStateName,
  type PrTriageRow,
  type TriageState,
} from "@corbits/triage-contracts";

const ARTIFACT_KIND = "document";
const SOURCE = { origin: "workflow", producer: "triage-reconciler" };
// The advisory lock `findOrVersionArtifact` takes: same namespace, same key (tenant, kind and
// title joined by unit separators), so a first write here and the package never both create.
const FIND_OR_VERSION_LOCK_NAMESPACE = 0x0a27_1f05;

export type TriageStateStoreDeps = {
  db: ArtifactDb;
  /** The principal hub writes are recorded as. */
  writerFor: (tenantId: string) => Promise<string>;
  log: (entry: Record<string, unknown>) => void;
};

/** The artifact version a load read; null when nothing is stored yet. */
export type TriageStateVersion = { artifactId: string; version: number } | null;

export type LoadedTriageState = { rows: PrTriageRow[]; version: TriageStateVersion };

export type TriageStateStore = {
  load(tenantId: string, repo: string): Promise<LoadedTriageState>;
  /** Writes on top of `expected`; throws `TriageStateConflictError` when the state changed since that load. */
  save(tenantId: string, repo: string, rows: PrTriageRow[], expected: TriageStateVersion): Promise<TriageStateVersion>;
};

export class TriageStateConflictError extends Error {
  constructor(repo: string) {
    super(`triage state for ${repo} changed since it was loaded`);
  }
}

/** The package throws its `VersionConflictError` on a stale `expectedVersion` but does not export the class. */
function isVersionConflict(err: unknown): boolean {
  return err instanceof Error && err.name === "VersionConflictError";
}

export function createTriageStateStore(deps: TriageStateStoreDeps): TriageStateStore {
  async function load(tenantId: string, repo: string): Promise<LoadedTriageState> {
    const found = await findArtifactByTitle(deps.db, tenantId, triageStateName(repo), ARTIFACT_KIND);
    if (!found) return { rows: [], version: null };
    const row = await getArtifact(deps.db, found.artifactId);
    if (!row) return { rows: [], version: null };
    const version = { artifactId: row.id, version: row.version };
    const state = parseTriageState(row.content, repo);
    // Unreadable state only costs a re-derivation from the run log; the next save replaces it.
    if (!state) {
      deps.log({ level: "warn", msg: "triage_state_unreadable", tenantId, repo, artifactId: found.artifactId });
      return { rows: [], version };
    }
    return { rows: state.prs, version };
  }

  async function save(tenantId: string, repo: string, rows: PrTriageRow[], expected: TriageStateVersion): Promise<TriageStateVersion> {
    const state: TriageState = { kind: TRIAGE_STATE_KIND, schemaVersion: TRIAGE_STATE_SCHEMA_VERSION, repo, prs: rows };
    const content = JSON.stringify(state);
    const title = triageStateName(repo);
    const scope = { tenantId, principalId: await deps.writerFor(tenantId) };
    if (expected === null) {
      return deps.db.transaction(async function createOnce(tx) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${FIND_OR_VERSION_LOCK_NAMESPACE}, hashtext(${`${tenantId}\x1f${ARTIFACT_KIND}\x1f${title}`}))`);
        if (await findArtifactByTitle(tx, tenantId, title, ARTIFACT_KIND)) throw new TriageStateConflictError(repo);
        const created = await createArtifact(tx, { scope, ownerPrincipalId: null, kind: ARTIFACT_KIND, title, content, source: SOURCE });
        return { artifactId: created.id, version: created.version };
      });
    }
    try {
      const written = await writeArtifactVersion(deps.db, { scope, artifactId: expected.artifactId, content, expectedVersion: expected.version });
      return { artifactId: written.artifactId, version: written.version };
    } catch (err) {
      if (isVersionConflict(err)) throw new TriageStateConflictError(repo);
      throw err;
    }
  }

  return { load, save };
}
