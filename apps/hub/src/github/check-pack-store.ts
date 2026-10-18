// A repository's policy is its policy file (see policy-file.ts) or its saved rules: the artifact its record pins by id,
// which the portal writes when it saves the policy. A repository not saved since pins existed, or whose pinned policy is
// archived, reads the newest artifact titled for it. While a repository has both and they run differently, the saved
// rules apply until the maintainer settles it; once they run the same, the saved rules are archived and the file is the
// policy. A policy that extends a workspace policy is resolved against that policy's current version here, so each mail
// carries the pack and the versions it was built from.
import { eq } from "drizzle-orm";
import { findArtifactByTitle, getArtifact, setArtifactArchived, type ArtifactDb, type ArtifactRow } from "@corbits/artifacts";
import { schema, type DB } from "@intx/db";
import { checkPackName, exportPolicyFile, extendsOf, policyDifferences, readCheckPack, readPolicyFile, storedPolicyPack, type ActionKind, type ArtifactRef, type CheckPack, type PolicySource, type PolicyUpgrade } from "@corbits/triage-contracts";
import type { PolicyFileState } from "./policy-file.js";
import { repoRecords, triageNs } from "./tenant-config.js";

/** `automatic` is the Do kinds the pr-triage role is granted on the repository; `source` is what `pack` was resolved from. */
export type StoredPack = { pack: CheckPack; automatic: ActionKind[]; source: PolicySource };

/** A corrupt policy names its artifact, which a save replaces in place; an invalid one is a policy file triage refuses. */
export type CheckPackRead =
  | ({ status: "ok" } & StoredPack)
  | { status: "missing" }
  | { status: "corrupt"; reason: string; repo: ArtifactRef }
  | { status: "invalid"; reason: string; path: string };

/** Saved rules as read: what `loadCheckPack` answers. */
type SavedRead = ({ status: "ok" } & StoredPack & { source: { repo: ArtifactRef; shared?: ArtifactRef } }) | Extract<CheckPackRead, { status: "missing" | "corrupt" }>;
type SavedPack = Extract<SavedRead, { status: "ok" }>;

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
function resolved(tenantId: string, repo: string, content: unknown, shared: ArtifactRow | null | undefined): Pick<StoredPack, "pack"> & { shared?: ArtifactRef } {
  if (shared && shared.tenantId !== tenantId) throw new Error("The workspace policy it extends belongs to another workspace.");
  return { pack: storedPolicyPack(repo, content, shared && { title: shared.title, content: shared.content }), ...(shared && { shared: refOf(shared) }) };
}

async function sharedOf(artifacts: ArtifactDb, content: unknown): Promise<ArtifactRow | null | undefined> {
  const id = extendsOf(content);
  return id === undefined ? undefined : getArtifact(artifacts, id);
}

function corrupt(row: ArtifactRow, error: unknown): SavedRead {
  if (!(error instanceof Error)) throw error;
  return { status: "corrupt", reason: error.message, repo: refOf(row) };
}

export async function loadCheckPack(deps: CheckPackStoreDeps, tenantId: string, repo: string): Promise<SavedRead> {
  try {
    checkPackName(repo);
  } catch {
    return { status: "missing" };
  }
  const row = await repoPolicyRow(deps, tenantId, repo);
  if (!row) return { status: "missing" };
  let read: ReturnType<typeof resolved>;
  try {
    read = resolved(tenantId, repo, row.content, await sharedOf(deps.artifacts, row.content));
  } catch (error) {
    return corrupt(row, error);
  }
  const source = { repo: refOf(row), ...(read.shared && { shared: read.shared }) };
  if (source.shared) deps.log({ level: "info", msg: "policy_shared_resolved", tenantId, repo, source });
  return { status: "ok", pack: read.pack, source, automatic: await deps.automaticKinds(tenantId, repo) };
}

type FileRead = Extract<CheckPackRead, { status: "ok" | "invalid" }>;

async function fileRead(deps: CheckPackStoreDeps, tenantId: string, repo: string, file: Exclude<PolicyFileState, { status: "absent" }>): Promise<FileRead> {
  if (file.status === "invalid") return { status: "invalid", reason: file.reason, path: file.path };
  let read: ReturnType<typeof resolved>;
  try {
    read = resolved(tenantId, repo, file.policy, await sharedOf(deps.artifacts, file.policy));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { status: "invalid", reason: error.message, path: file.file.path };
  }
  const source: PolicySource = { file: { path: file.file.path, sha: file.file.sha }, ...(read.shared && { shared: read.shared }) };
  return { status: "ok", pack: read.pack, source, automatic: await deps.automaticKinds(tenantId, repo) };
}

/** Archiving hides and keeps restorable; every saved policy titled for the repository goes, since an older one would otherwise become the saved rules. */
async function retireSaved(deps: CheckPackStoreDeps, tenantId: string, repo: string): Promise<void> {
  for (let row = await repoPolicyRow(deps, tenantId, repo); row; row = await repoPolicyRow(deps, tenantId, repo)) {
    await setArtifactArchived(deps.artifacts, row, true);
    deps.log({ level: "info", msg: "policy_saved_retired", tenantId, repo, artifact: row.id, version: row.version });
  }
}

function exported(saved: SavedPack) {
  return exportPolicyFile(saved.pack, saved.source.shared !== undefined);
}

/** Whether writing the saved rules to the file would change what it does; it would not when the rest is what a file cannot hold. */
function fileCanChange(saved: SavedPack, read: FileRead, repo: string): boolean {
  if (read.status !== "ok") return true;
  return policyDifferences(readCheckPack(readPolicyFile(exported(saved).text, repo), repo), read.pack).length > 0;
}

export type PolicySettled = { read: CheckPackRead; upgrade: PolicyUpgrade; saved?: SavedPack };

/**
 * The policy triage runs on and how the repository's saved rules stand against its policy file: neither is `start`;
 * saved rules and no file is `upgrade`; both, running differently or with a file triage refuses, is `differs`, and the
 * saved rules apply; else the file or the saved rules alone apply and it is `ok`.
 */
export async function settlePolicy(deps: CheckPackStoreDeps & { policyFile: (tenantId: string, repo: string) => Promise<PolicyFileState> }, tenantId: string, repo: string): Promise<PolicySettled> {
  const file = await deps.policyFile(tenantId, repo);
  const stored = await loadCheckPack(deps, tenantId, repo);
  const saved = stored.status === "ok" ? stored : undefined;
  if (file.status === "absent" && saved) return { read: stored, upgrade: { state: "upgrade", saved: saved.source.repo, unexpressed: exported(saved).unexpressed }, saved };
  if (file.status === "absent") return { read: stored, upgrade: { state: stored.status === "missing" ? "start" : "ok" } };
  const read = await fileRead(deps, tenantId, repo, file);
  if (!saved) return { read, upgrade: { state: "ok" } };
  const differences = read.status === "ok" ? policyDifferences(saved.pack, read.pack) : [];
  const problem = read.status === "ok" ? undefined : read.reason;
  if (differences.length > 0 || problem) return { read: saved, upgrade: { state: "differs", path: file.status === "ok" ? file.file.path : file.path, saved: saved.source.repo, differences, ...(problem && { problem }), fixable: fileCanChange(saved, read, repo), unexpressed: exported(saved).unexpressed }, saved };
  await retireSaved(deps, tenantId, repo);
  return { read, upgrade: { state: "ok" } };
}
