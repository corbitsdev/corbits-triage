// Per-repository triage state, one artifact beside the repository's check pack.
import { findArtifactByTitle, findOrVersionArtifact, getArtifact, type ArtifactDb } from "@corbits/artifacts";
import {
  parseTriageState,
  TRIAGE_STATE_KIND,
  TRIAGE_STATE_SCHEMA_VERSION,
  triageStateName,
  type PrTriageRow,
  type TriageState,
} from "@corbits/triage-contracts";

const ARTIFACT_KIND = "document";

export type TriageStateStoreDeps = {
  db: ArtifactDb;
  /** The principal hub writes are recorded as. */
  writerFor: (tenantId: string) => Promise<string>;
};

export type TriageStateStore = {
  load(tenantId: string, repo: string): Promise<PrTriageRow[]>;
  save(tenantId: string, repo: string, rows: PrTriageRow[]): Promise<void>;
};

export function createTriageStateStore(deps: TriageStateStoreDeps): TriageStateStore {
  async function load(tenantId: string, repo: string): Promise<PrTriageRow[]> {
    const found = await findArtifactByTitle(deps.db, tenantId, triageStateName(repo), ARTIFACT_KIND);
    if (!found) return [];
    const row = await getArtifact(deps.db, found.artifactId);
    if (!row) return [];
    const state = parseTriageState(row.content, repo);
    if (!state) throw new Error(`triage state for ${repo} is corrupt`);
    return state.prs;
  }

  async function save(tenantId: string, repo: string, rows: PrTriageRow[]): Promise<void> {
    const state: TriageState = { kind: TRIAGE_STATE_KIND, schemaVersion: TRIAGE_STATE_SCHEMA_VERSION, repo, prs: rows };
    const principalId = await deps.writerFor(tenantId);
    await findOrVersionArtifact(deps.db, {
      scope: { tenantId, principalId },
      ownerPrincipalId: null,
      kind: ARTIFACT_KIND,
      title: triageStateName(repo),
      content: JSON.stringify(state),
      source: { origin: "workflow", producer: "triage-reconciler" },
    });
  }

  return { load, save };
}
