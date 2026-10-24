// A repository's policy is its policy file (see policy-file.ts) or its saved rules: the artifact its record pins by id,
// which the portal writes when it saves the policy. A repository not saved since pins existed, or whose pinned policy is
// archived, reads the newest artifact titled for it. While a repository has both and they run differently, the saved
// rules apply until the maintainer settles it; once they run the same, the saved rules are archived and the file is the
// policy. A policy that extends a workspace policy is resolved against that policy's current version here, and a policy
// file that extends another repository against that repository's policy file as the hub last read it, so each mail
// carries the pack and the versions it was built from.
import { eq } from "drizzle-orm";
import { findArtifactByTitle, getArtifact, setArtifactArchived, type ArtifactDb, type ArtifactRow } from "@corbits/artifacts";
import { schema, type DB } from "@intx/db";
import { asRepo } from "@corbits/common";
import { checkPackName, exportPolicyFile, extendedFilePack, extendsOf, policyDifferences, readCheckPack, readPolicyFile, refuseUnknownChecks, storedPolicyPack, type ActionKind, type ArtifactRef, type CheckPack, type PolicySource, type PolicyUpgrade, type PolicyWorkflow, type RepoSource, type SharedFileRef } from "@corbits/triage-contracts";
import type { PolicyFileState } from "./policy-file.js";
import { prWorkflowKeys } from "./pr-workflow.js";
import { repoRecords, sourceOf, triageNs } from "./tenant-config.js";

/**
 * `automatic` is the Do kinds the pr-triage role is granted on the repository; `source` is what `pack` was resolved from;
 * `policyWorkflow` the policy file's v4 keys while only the PR workflow can run them; `pauseLabel` the file's, whichever runs it.
 */
export type StoredPack = { pack: CheckPack; automatic: ActionKind[]; source: PolicySource; policyWorkflow?: PolicyWorkflow; pauseLabel?: string };

function withPrWorkflowKeys(workflow: PolicyWorkflow, pack: CheckPack): Pick<StoredPack, "policyWorkflow"> {
  const policyWorkflow = prWorkflowKeys(workflow, pack);
  return policyWorkflow ? { policyWorkflow } : {};
}

/** A corrupt policy names its artifact, which a save replaces in place; an invalid one is a policy file triage refuses. */
export type CheckPackRead =
  | ({ status: "ok" } & StoredPack)
  | { status: "missing" }
  | { status: "corrupt"; reason: string; repo: ArtifactRef; automatic: ActionKind[] }
  | { status: "invalid"; reason: string; path: string; automatic: ActionKind[] };

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

/**
 * The id `repo`'s record on its host pins, whether it may fall back to the newest policy titled for it, and the ids its
 * namesakes on other hosts pin. Only GitHub repositories predate pins, so only they fall back. The record is tenant
 * config a manager may write, so an id's type is not trusted.
 */
async function policyPins(db: DB["db"], tenantId: string, repo: string, source: RepoSource): Promise<{ own: string | undefined; titled: boolean; others: string[] }> {
  const tenant = await db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
  const named = repoRecords(triageNs(tenant?.config)).filter((record) => record.name === repo);
  const id: unknown = named.find((record) => sourceOf(record) === source)?.checkPack?.id;
  const others = named.filter((record) => sourceOf(record) !== source).map((record): unknown => record.checkPack?.id);
  return { own: typeof id === "string" ? id : undefined, titled: source === "github", others: others.filter((other) => typeof other === "string") };
}

async function usablePolicy(artifacts: ArtifactDb, tenantId: string, id: string | undefined): Promise<ArtifactRow | undefined> {
  const row = id === undefined ? null : await getArtifact(artifacts, id);
  return row && row.tenantId === tenantId && row.archivedAt === null ? row : undefined;
}

/** Saved rules are titled by name alone, so a policy found by its title is never one a namesake on another host pins. */
export async function repoPolicyRow({ db, artifacts }: Pick<CheckPackStoreDeps, "db" | "artifacts">, tenantId: string, repo: string, source: RepoSource): Promise<ArtifactRow | undefined> {
  const pins = await policyPins(db, tenantId, repo, source);
  const pinned = await usablePolicy(artifacts, tenantId, pins.own);
  if (pinned || !pins.titled) return pinned;
  const titled = (await findArtifactByTitle(artifacts, tenantId, checkPackName(repo)))?.artifactId;
  return titled === undefined || pins.others.includes(titled) ? undefined : usablePolicy(artifacts, tenantId, titled);
}

/** `shared` is undefined when the policy extends none. An archived shared policy still applies: archiving hides, it does not revoke. */
function resolved(tenantId: string, repo: string, content: unknown, shared: ArtifactRow | null | undefined): Pick<StoredPack, "pack"> & { shared?: ArtifactRef } {
  if (shared && shared.tenantId !== tenantId) throw new Error("The workspace policy it extends belongs to another workspace.");
  refuseUnknownChecks(content);
  if (shared) refuseUnknownChecks(shared.content);
  return { pack: storedPolicyPack(repo, content, shared && { title: shared.title, content: shared.content }), ...(shared && { shared: refOf(shared) }) };
}

async function sharedOf(artifacts: ArtifactDb, content: unknown): Promise<ArtifactRow | null | undefined> {
  const id = extendsOf(content);
  if (id !== undefined && asRepo(id) !== undefined) throw new Error("Only a policy file can extend another repository's policy.");
  return id === undefined ? undefined : getArtifact(artifacts, id);
}

function corrupt(row: ArtifactRow, error: unknown, automatic: ActionKind[]): SavedRead {
  if (!(error instanceof Error)) throw error;
  return { status: "corrupt", reason: error.message, repo: refOf(row), automatic };
}

export async function loadCheckPack(deps: CheckPackStoreDeps, tenantId: string, repo: string, source: RepoSource): Promise<SavedRead> {
  try {
    checkPackName(repo);
  } catch {
    return { status: "missing" };
  }
  const row = await repoPolicyRow(deps, tenantId, repo, source);
  if (!row) return { status: "missing" };
  let read: ReturnType<typeof resolved>;
  try {
    read = resolved(tenantId, repo, row.content, await sharedOf(deps.artifacts, row.content));
  } catch (error) {
    return corrupt(row, error, await deps.automaticKinds(tenantId, repo));
  }
  const from = { repo: refOf(row), ...(read.shared && { shared: read.shared }) };
  if (from.shared) deps.log({ level: "info", msg: "policy_shared_resolved", tenantId, repo, source: from });
  return { status: "ok", pack: read.pack, source: from, automatic: await deps.automaticKinds(tenantId, repo) };
}

type FileRead = Extract<CheckPackRead, { status: "ok" | "invalid" }>;

/** `source` is the repository's host; a caller without one reads no file where both hosts hold the name. */
type PolicyFileReader = (tenantId: string, repo: string, source: RepoSource | undefined) => Promise<PolicyFileState>;

/** The policy triage runs on for `repo` on `source`. */
export type PolicyReader = (tenantId: string, repo: string, source: RepoSource) => Promise<CheckPackRead>;

/** Over the policy file of the repository `extends` names, read with this workspace's own access to it. */
async function overSharedFile(policyFile: PolicyFileReader, tenantId: string, repo: string, source: RepoSource | undefined, content: Record<string, unknown>, shared: string): Promise<Pick<StoredPack, "pack"> & { sharedFile: SharedFileRef }> {
  const state = await policyFile(tenantId, shared, source);
  if (state.status === "absent") throw new Error(`${shared} is not connected to this workspace or has no policy file.`);
  if (state.status === "invalid") throw new Error(`${shared}'s policy file is refused: ${state.reason}`);
  return { pack: extendedFilePack(repo, content, { repo: shared, policy: state.policy }), sharedFile: { repo: shared, path: state.file.path, sha: state.file.sha } };
}

async function fileResolved(deps: CheckPackStoreDeps & { policyFile: PolicyFileReader }, tenantId: string, repo: string, source: RepoSource | undefined, content: Record<string, unknown>) {
  const shared = extendsOf(content);
  if (shared !== undefined && asRepo(shared) !== undefined) return overSharedFile(deps.policyFile, tenantId, repo, source, content, shared);
  return resolved(tenantId, repo, content, await sharedOf(deps.artifacts, content));
}

/** Why triage would refuse a policy file holding `policy`, resolved as a pushed file is; undefined when it would run it. */
export async function fileRefusal(deps: CheckPackStoreDeps & { policyFile: PolicyFileReader }, tenantId: string, repo: string, source: RepoSource | undefined, policy: Record<string, unknown>): Promise<string | undefined> {
  try {
    await fileResolved(deps, tenantId, repo, source, policy);
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
}

async function fileRead(deps: CheckPackStoreDeps & { policyFile: PolicyFileReader }, tenantId: string, repo: string, host: RepoSource | undefined, file: Exclude<PolicyFileState, { status: "absent" }>): Promise<FileRead> {
  if (file.status === "invalid") return { status: "invalid", reason: file.reason, path: file.path, automatic: await deps.automaticKinds(tenantId, repo) };
  let read: Awaited<ReturnType<typeof fileResolved>>;
  try {
    read = await fileResolved(deps, tenantId, repo, host, file.policy);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { status: "invalid", reason: error.message, path: file.file.path, automatic: await deps.automaticKinds(tenantId, repo) };
  }
  const { pack, ...from } = read;
  const source: PolicySource = { file: { path: file.file.path, sha: file.file.sha }, ...from };
  return { status: "ok", pack, source, automatic: await deps.automaticKinds(tenantId, repo), ...withPrWorkflowKeys(file.workflow, pack), ...(file.workflow.pauseLabel && { pauseLabel: file.workflow.pauseLabel }) };
}

/** Archiving hides and keeps restorable; every saved policy titled for the repository goes, since an older one would otherwise become the saved rules. */
async function retireSaved(deps: CheckPackStoreDeps, tenantId: string, repo: string, source: RepoSource): Promise<void> {
  for (let row = await repoPolicyRow(deps, tenantId, repo, source); row; row = await repoPolicyRow(deps, tenantId, repo, source)) {
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
export async function settlePolicy(deps: CheckPackStoreDeps & { policyFile: PolicyFileReader }, tenantId: string, repo: string, source: RepoSource): Promise<PolicySettled> {
  const file = await deps.policyFile(tenantId, repo, source);
  const stored = await loadCheckPack(deps, tenantId, repo, source);
  const saved = stored.status === "ok" ? stored : undefined;
  if (file.status === "absent" && saved) return { read: stored, upgrade: { state: "upgrade", saved: saved.source.repo, unexpressed: exported(saved).unexpressed }, saved };
  if (file.status === "absent") return { read: stored, upgrade: { state: stored.status === "missing" ? "start" : "ok" } };
  const read = await fileRead(deps, tenantId, repo, source, file);
  if (!saved) return { read, upgrade: { state: "ok" } };
  const differences = read.status === "ok" ? policyDifferences(saved.pack, read.pack) : [];
  const problem = read.status === "ok" ? undefined : read.reason;
  if (differences.length > 0 || problem) return { read: saved, upgrade: { state: "differs", path: file.status === "ok" ? file.file.path : file.path, saved: saved.source.repo, differences, ...(problem && { problem }), fixable: fileCanChange(saved, read, repo), unexpressed: exported(saved).unexpressed }, saved };
  await retireSaved(deps, tenantId, repo, source);
  return { read, upgrade: { state: "ok" } };
}
