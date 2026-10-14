// A repository's policy kept in `.corbits-triage.yaml` on its default branch. A sync stores what the file holds as a
// new version of the repository's policy, marked with the file's blob sha, so triage keeps reading the hub's copy and
// the version names the file it came from. Pushes to the default branch that touch the file sync; so does the sync route.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { createArtifact, writeArtifactVersion, type ArtifactDb, type ArtifactRow, type ArtifactTx, type ResolvedPrincipal } from "@corbits/artifacts";
import { schema } from "@intx/db";
import { asRecord, errorText } from "@corbits/common";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { json, readRepoFile, type GithubFetch, type RepoFileRead } from "@corbits/github-reads";
import { readRepo } from "../bitbucket-datacenter/client.js";
import { splitName } from "../bitbucket-datacenter/records.js";
import type { TenantBitbucket } from "../bitbucket-datacenter/tenant-bitbucket.js";
import { checkPackName, POLICY_FILE_PATH, policyFileText, readPolicyFile, type PolicyFileStatus } from "@corbits/triage-contracts";
import { fileMarkerOf, repoPolicyRow, type FileMarker } from "./check-pack-store.js";
import { forInstallation } from "./open-pulls.js";
import { failure, holds, sourceCredentialGrant, type PortalCredentialDeps } from "./portal-credential.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./tenant-config.js";
import { githubFailed } from "./github-refusal.js";
import { isVersionConflict } from "./triage-state-store.js";
import type { Member } from "../integrations/app.js";

export const PolicyFileBody = type({ repo: /^[\w.-]+\/[\w.-]+$/ });

export const EXPORT_BRANCH = "corbits-triage/policy";

const PR_TITLE = "chore: keep the Corbits Triage policy in .corbits-triage.yaml";

function prBody(schemaUrl: string): string {
  return [
    `Adds \`${POLICY_FILE_PATH}\` with this repository's current Corbits Triage policy.`,
    "",
    "Once merged, the hub reads the policy from this file on every push to the default branch, and the portal shows it read-only with a link here. Edit the policy by changing this file.",
    "",
    `Schema: ${schemaUrl} (\`policyFile\`).`,
  ].join("\n");
}

export type PolicyFileDeps = PortalCredentialDeps & {
  artifacts: ArtifactDb;
  /** GitHub as the tenant's App; undefined when the tenant has no active GitHub App credential. */
  tenantGithub: (tenantId: string) => Promise<GithubFetch | undefined>;
  tenantBitbucket: TenantBitbucket;
  /** The principal every sync is recorded as, so syncing never makes a member a policy's creator. */
  writerFor: (tenantId: string) => Promise<string>;
  /** Grants a new policy's writers, as the stock artifact route does for one it creates. */
  grantWriters: (tx: ArtifactTx, row: ArtifactRow, scope: ResolvedPrincipal) => Promise<void>;
  schemaUrl: string;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};


export type PolicyFileSync =
  | { status: "synced" | "unchanged"; sha: string }
  | { status: "absent" | "removed" }
  | { status: "invalid"; reason: string };

const SYNC_ATTEMPTS = 3;

/** Why the file at the path cannot be used as a policy; a reply, not a GitHub failure. */
class PolicyFileProblem extends Error {}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  const row = asRecord(value);
  return row ? Object.fromEntries(Object.keys(row).sort().map((key) => [key, sortedKeys(row[key])])) : value;
}

/** The portal and the hub write keys in different orders, so policies compare by content. */
function samePolicy(content: string, policy: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(sortedKeys(JSON.parse(content))) === JSON.stringify(sortedKeys(policy));
  } catch {
    return false;
  }
}

function policyOf(file: Extract<RepoFileRead, { kind: "file" }>, repo: string): Record<string, unknown> {
  if (file.text === null) throw new Error(`${POLICY_FILE_PATH} is too large or uses aliases.`);
  return readPolicyFile(file.text, repo);
}

function withoutMarker(metadata: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(asRecord(metadata) ?? {}).filter(([key]) => key !== "policyFile"));
}

const NOT_A_FILE = `${POLICY_FILE_PATH} is not a file.`;

export function createPolicyFile(deps: PolicyFileDeps) {
  /** A Bitbucket repository the token sees has no record until it is enabled, so rules can be written for it first, as for GitHub. */
  async function visibleBitbucketRecord(tenantId: string, repo: string): Promise<RepoRecord | undefined> {
    const bb = await deps.tenantBitbucket(tenantId);
    if (!bb || !(await readRepo(bb, ...splitName(repo)))) return undefined;
    return { name: repo, source: "bitbucket-datacenter", connected: true };
  }

  async function connectedRecord(tenantId: string, repo: string): Promise<RepoRecord | undefined> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    return repoRecords(triageNs(tenant?.config)).find((row) => row.name === repo && row.connected) ?? visibleBitbucketRecord(tenantId, repo);
  }

  async function repoGithub(tenantId: string, record: RepoRecord): Promise<GithubFetch> {
    const gh = await deps.tenantGithub(tenantId);
    if (!gh) throw new Error("no active github credential");
    return forInstallation(gh, record.installationId);
  }

  /** The policy file on the record's default branch, read from its host. */
  async function readFile(tenantId: string, record: RepoRecord): Promise<RepoFileRead | undefined> {
    if (sourceOf(record) !== "bitbucket-datacenter") return readRepoFile(await repoGithub(tenantId, record), record.name, POLICY_FILE_PATH);
    const bb = await deps.tenantBitbucket(tenantId);
    if (!bb) throw new Error("no active bitbucket-datacenter credential");
    return bitbucket.readRepoFile(bb, record.name, POLICY_FILE_PATH, record.defaultBranch);
  }

  async function store(scope: ResolvedPrincipal, repo: string, content: string, marker: FileMarker, row: ArtifactRow | undefined): Promise<void> {
    if (row) {
      await writeArtifactVersion(deps.artifacts, { scope, artifactId: row.id, content, metadata: { ...asRecord(row.metadata), policyFile: marker }, expectedVersion: row.version });
      return;
    }
    const title = checkPackName(repo);
    await deps.artifacts.transaction(async function createPolicy(tx) {
      const created = await createArtifact(tx, { scope, ownerPrincipalId: null, kind: "document", title, content, source: { origin: "workflow", producer: "policy-file" }, metadata: { checkPack: title, policyFile: marker } });
      await deps.grantWriters(tx, created, scope);
    });
  }

  async function dropMarker(scope: ResolvedPrincipal, repo: string): Promise<PolicyFileSync> {
    const row = await repoPolicyRow(deps, scope.tenantId, repo);
    if (!row || !fileMarkerOf(row)) return { status: "absent" };
    try {
      await writeArtifactVersion(deps.artifacts, { scope, artifactId: row.id, content: row.content, metadata: withoutMarker(row.metadata), expectedVersion: row.version });
    } catch (err) {
      // Whoever wrote first changed the content, which already ends the marker.
      if (!isVersionConflict(err)) throw err;
    }
    deps.log({ level: "info", msg: "policy_file_removed", tenantId: scope.tenantId, repo });
    return { status: "removed" };
  }

  /**
   * Reads the file on the default branch and stores it when the hub's copy differs, as the tenant's GitHub sender. Only
   * a push that lists the file as removed drops the marker; a file not found otherwise writes nothing.
   */
  async function sync(tenantId: string, record: RepoRecord, removed: boolean): Promise<PolicyFileSync> {
    const repo = record.name;
    const scope = { tenantId, principalId: await deps.writerFor(tenantId) };
    const file = await readFile(tenantId, record);
    if (!file && removed) return dropMarker(scope, repo);
    if (!file) {
      deps.log({ level: "warn", msg: "policy_file_not_found", tenantId, repo });
      return { status: "absent" };
    }
    let policy: Record<string, unknown>;
    try {
      if (file.kind === "not-a-file") throw new Error(NOT_A_FILE);
      policy = policyOf(file, repo);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      deps.log({ level: "warn", msg: "policy_file_invalid", tenantId, repo, reason: error.message });
      return { status: "invalid", reason: error.message };
    }
    const content = JSON.stringify(policy);
    const marker = { path: POLICY_FILE_PATH, sha: file.sha, syncedAt: deps.now().toISOString(), contentSha256: createHash("sha256").update(content).digest("hex") };
    for (let attempt = 1; ; attempt += 1) {
      const row = await repoPolicyRow(deps, tenantId, repo);
      if (row && samePolicy(row.content, policy) && fileMarkerOf(row)?.sha === file.sha) return { status: "unchanged", sha: file.sha };
      try {
        await store(scope, repo, content, marker, row);
        deps.log({ level: "info", msg: "policy_file_synced", tenantId, repo, sha: file.sha });
        return { status: "synced", sha: file.sha };
      } catch (err) {
        if (!isVersionConflict(err) || attempt === SYNC_ATTEMPTS) throw err;
      }
    }
  }

  /** Whether the repository holds the file and the hub's copy is what it says; undefined when there is no file. */
  async function status(tenantId: string, record: RepoRecord): Promise<PolicyFileStatus | undefined> {
    const repo = record.name;
    const file = await readFile(tenantId, record);
    if (!file) return undefined;
    if (file.kind === "not-a-file") throw new PolicyFileProblem(NOT_A_FILE);
    const row = await repoPolicyRow(deps, tenantId, repo);
    const marker = row && fileMarkerOf(row);
    const base = { path: POLICY_FILE_PATH, sha: file.sha, url: file.url, ...(marker && { syncedAt: marker.syncedAt }) };
    try {
      const policy = policyOf(file, repo);
      return { ...base, inSync: row !== undefined && samePolicy(row.content, policy) };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { ...base, inSync: false, problem: error.message };
    }
  }

  async function onPush(tenantId: string, repo: string, removed: boolean): Promise<PolicyFileSync | undefined> {
    const record = await connectedRecord(tenantId, repo);
    return record && sync(tenantId, record, removed);
  }

  async function grantedRecord(member: Member, repo: string, action: "read" | "use"): Promise<RepoRecord | Response> {
    const record = await connectedRecord(member.tenantId, repo);
    if (!record) return failure(409, "repo_not_connected", `${repo} is not connected to this workspace.`);
    return (await sourceCredentialGrant(deps, member.principalId, member.tenantId, record, action)) ?? record;
  }

  async function fileRoute({ repo }: typeof PolicyFileBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, repo, "read");
    if (record instanceof Response) return record;
    try {
      return Response.json({ file: (await status(member.tenantId, record)) ?? null });
    } catch (err) {
      if (err instanceof PolicyFileProblem) return failure(422, "policy_file_invalid", err.message);
      deps.log({ level: "warn", msg: "policy_file_status_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      return githubFailed(`read ${POLICY_FILE_PATH} from`, err);
    }
  }

  /** Using the file writes the policy, so it needs what a save from the portal needs: write on the policy, or create when there is none. */
  async function mayWritePolicy(member: Member, repo: string): Promise<boolean> {
    const row = await repoPolicyRow(deps, member.tenantId, repo);
    const [resource, action] = row ? [`artifact:${row.id}`, "write"] : ["artifact:*", "create"];
    return holds(deps, member.principalId, member.tenantId, resource, action);
  }

  async function syncRoute({ repo }: typeof PolicyFileBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, repo, "use");
    if (record instanceof Response) return record;
    if (!(await mayWritePolicy(member, repo))) return failure(403, "forbidden", `You may not change ${repo}'s policy.`);
    let synced: PolicyFileSync;
    try {
      synced = await sync(member.tenantId, record, false);
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_file_sync_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      return githubFailed(`read ${POLICY_FILE_PATH} from`, err);
    }
    if (synced.status === "absent" || synced.status === "removed") return failure(404, "policy_file_missing", `${repo} has no ${POLICY_FILE_PATH} on its default branch.`);
    if (synced.status === "invalid") return failure(422, "policy_file_invalid", synced.reason);
    return Response.json(synced);
  }


  async function createBranch(gh: GithubFetch, repo: string, sha: string): Promise<boolean> {
    const res = await gh(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${EXPORT_BRANCH}`, sha }) });
    if (res.ok) return true;
    if (res.status === 422 && (await res.text()).includes("Reference already exists")) return false;
    throw new Error(`github POST /repos/${repo}/git/refs -> ${res.status}`);
  }

  /** Exporting opens a pull request through the GitHub App; another host's repository keeps its policy in the hub. */
  async function exportRoute({ repo }: typeof PolicyFileBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, repo, "use");
    if (record instanceof Response) return record;
    if (sourceOf(record) !== "github") return failure(409, "export_unsupported", `${repo} is not on GitHub; add ${POLICY_FILE_PATH} to its default branch by hand.`);
    const row = await repoPolicyRow(deps, member.tenantId, repo);
    if (!row) return failure(409, "policy_missing", `${repo} has no policy to export.`);
    let stored: Record<string, unknown> | undefined;
    try {
      stored = asRecord(JSON.parse(row.content));
    } catch {
      stored = undefined;
    }
    if (!stored) return failure(409, "policy_corrupt", `${repo}'s policy is not readable; save it again first.`);
    const text = policyFileText(stored, deps.schemaUrl);
    let gh: GithubFetch | undefined;
    let branched = false;
    try {
      gh = await repoGithub(member.tenantId, record);
      if (await readRepoFile(gh, repo, POLICY_FILE_PATH)) return failure(409, "policy_file_exists", `${repo} already has ${POLICY_FILE_PATH}.`);
      const { default_branch: base } = await json(gh, `/repos/${repo}`);
      // Unverified against GitHub for a default branch whose name holds a slash.
      const head = await json(gh, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
      branched = await createBranch(gh, repo, head.object.sha);
      if (!branched) return failure(409, "policy_branch_exists", `${repo} already has a ${EXPORT_BRANCH} branch; merge or delete it first.`);
      await json(gh, `/repos/${repo}/contents/${POLICY_FILE_PATH}`, {
        method: "PUT",
        body: JSON.stringify({ message: `chore: add ${POLICY_FILE_PATH}`, content: Buffer.from(text, "utf8").toString("base64"), branch: EXPORT_BRANCH }),
      });
      const pull = await json(gh, `/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: PR_TITLE, head: EXPORT_BRANCH, base, body: prBody(deps.schemaUrl) }) });
      deps.log({ level: "info", msg: "policy_file_exported", tenantId: member.tenantId, repo, number: pull.number });
      return Response.json({ status: "opened", url: pull.html_url, number: pull.number });
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_file_export_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      if (gh && branched) await deleteBranch(gh, member.tenantId, repo);
      return githubFailed(`open a pull request adding ${POLICY_FILE_PATH} to`, err);
    }
  }

  /** A failed export takes back the branch it made, so trying again is not refused as already exported. */
  async function deleteBranch(gh: GithubFetch, tenantId: string, repo: string): Promise<void> {
    try {
      await json(gh, `/repos/${repo}/git/refs/heads/${EXPORT_BRANCH}`, { method: "DELETE" });
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_file_branch_left", tenantId, repo, branch: EXPORT_BRANCH, error: errorText(err) });
    }
  }

  return { onPush, fileRoute, syncRoute, exportRoute };
}

export type PolicyFile = ReturnType<typeof createPolicyFile>;
