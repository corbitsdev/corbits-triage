// A repository's policy is the artifact its record pins by id, which the portal writes when it saves the policy. A
// repository not saved since pins existed, or whose pinned policy is archived, reads the newest artifact titled for it.
// A policy that extends a workspace policy is resolved against that policy's current version here, so each mail carries
// the pack and the versions it was built from. Reading writes nothing.
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { findArtifactByTitle, getArtifact, type ArtifactDb, type ArtifactRow } from "@corbits/artifacts";
import { schema, type DB } from "@intx/db";
import { asRecord } from "@corbits/common";
import { checkPackName, extendsOf, storedPolicyPack, type ActionKind, type ArtifactRef, type CheckPack, type PolicySource } from "@corbits/triage-contracts";
import { repoRecords, triageNs } from "./tenant-config.js";

/** Version metadata a sync from the repository's policy file writes; `contentSha256` is the content it wrote. */
export const FileMarker = type({ path: "string", sha: "string", syncedAt: "string", contentSha256: "string" });
export type FileMarker = typeof FileMarker.infer;

/** A later save from the portal carries metadata forward, so the marker holds only while the content is what the sync wrote. */
export function fileMarkerOf(row: ArtifactRow): FileMarker | undefined {
  const marker = FileMarker(asRecord(row.metadata)?.["policyFile"]);
  return marker instanceof type.errors || marker.contentSha256 !== row.contentSha256 ? undefined : marker;
}

/** `automatic` is the Do kinds the pr-triage role is granted on the repository; `source` is what `pack` was resolved from. */
export type StoredPack = { pack: CheckPack; automatic: ActionKind[]; source: PolicySource };

/** A corrupt policy names its artifact, which a save replaces in place. */
export type CheckPackRead = ({ status: "ok" } & StoredPack) | { status: "missing" } | { status: "corrupt"; reason: string; repo: ArtifactRef };

/** One database, typed for Interchange and for the artifact package. */
export type CheckPackStoreDeps = {
  db: DB["db"];
  artifacts: ArtifactDb;
  automaticKinds: (tenantId: string, repo: string) => Promise<ActionKind[]>;
  log: (entry: Record<string, unknown>) => void;
};

function refOf(row: ArtifactRow): ArtifactRef {
  return { id: row.id, version: row.version };
}

/** The record is tenant config a manager may write, so the id's type is not trusted. */
async function pinnedPolicyId(db: DB["db"], tenantId: string, repo: string): Promise<string | undefined> {
  const tenant = await db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
  const id: unknown = repoRecords(triageNs(tenant?.config)).find((record) => record.name === repo)?.checkPack?.id;
  return typeof id === "string" ? id : undefined;
}

async function usablePolicy(artifacts: ArtifactDb, tenantId: string, id: string | undefined): Promise<ArtifactRow | undefined> {
  const row = id === undefined ? null : await getArtifact(artifacts, id);
  return row && row.tenantId === tenantId && row.archivedAt === null ? row : undefined;
}

export async function repoPolicyRow({ db, artifacts }: Pick<CheckPackStoreDeps, "db" | "artifacts">, tenantId: string, repo: string): Promise<ArtifactRow | undefined> {
  const pinned = await usablePolicy(artifacts, tenantId, await pinnedPolicyId(db, tenantId, repo));
  if (pinned) return pinned;
  return usablePolicy(artifacts, tenantId, (await findArtifactByTitle(artifacts, tenantId, checkPackName(repo)))?.artifactId);
}

/** `shared` is undefined when the policy extends none. An archived shared policy still applies: archiving hides, it does not revoke. */
function readStored(tenantId: string, repo: string, row: ArtifactRow, shared: ArtifactRow | null | undefined): Pick<StoredPack, "pack" | "source"> {
  if (shared && shared.tenantId !== tenantId) throw new Error("The workspace policy it extends belongs to another workspace.");
  const file = fileMarkerOf(row);
  return {
    pack: storedPolicyPack(repo, row.content, shared && { title: shared.title, content: shared.content }),
    source: { repo: refOf(row), ...(shared && { shared: refOf(shared) }), ...(file && { file: { path: file.path, sha: file.sha } }) },
  };
}

function corrupt(row: ArtifactRow, error: unknown): CheckPackRead {
  if (!(error instanceof Error)) throw error;
  return { status: "corrupt", reason: error.message, repo: refOf(row) };
}

export async function loadCheckPack(deps: CheckPackStoreDeps, tenantId: string, repo: string): Promise<CheckPackRead> {
  try {
    checkPackName(repo);
  } catch {
    return { status: "missing" };
  }
  const row = await repoPolicyRow(deps, tenantId, repo);
  if (!row) return { status: "missing" };
  let sharedId: string | undefined;
  try {
    sharedId = extendsOf(row.content);
  } catch (error) {
    return corrupt(row, error);
  }
  const shared = sharedId === undefined ? undefined : await getArtifact(deps.artifacts, sharedId);
  let resolved: Pick<StoredPack, "pack" | "source">;
  try {
    resolved = readStored(tenantId, repo, row, shared);
  } catch (error) {
    return corrupt(row, error);
  }
  if (resolved.source.shared) deps.log({ level: "info", msg: "policy_shared_resolved", tenantId, repo, source: resolved.source });
  return { status: "ok", ...resolved, automatic: await deps.automaticKinds(tenantId, repo) };
}
