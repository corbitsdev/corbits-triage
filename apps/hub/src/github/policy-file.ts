// A repository's policy kept in `.corbits-triage.yaml` on its default branch. A sync stores what the file holds as a
// new version of the repository's policy, marked with the file's blob sha, so triage keeps reading the hub's copy and
// the version names the file it came from. Pushes to the default branch sync; so does the sync route.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { createArtifact, writeArtifactVersion, type ArtifactDb, type ArtifactRow, type ArtifactTx, type ResolvedPrincipal } from "@corbits/artifacts";
import { schema } from "@intx/db";
import { asRecord, errorText } from "@corbits/common";
import { json, readRepoFile, type GithubFetch } from "@corbits/github-reads";
import { checkPackName, POLICY_FILE_PATH, policyFileText, readPolicyFile, type PolicyFileStatus } from "@corbits/triage-contracts";
import { fileMarkerOf, repoPolicyRow, type FileMarker } from "./check-pack-store.js";
import { forInstallation } from "./open-pulls.js";
import { failure, githubAppGrant, type PortalCredentialDeps } from "./portal-credential.js";
import { repoRecords, triageNs, type RepoRecord } from "./tenant-config.js";
import { githubFailed } from "./github-refusal.js";
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
  /** The principal hub writes are recorded as. */
  writerFor: (tenantId: string) => Promise<string>;
  /** Grants a new policy's writers, as the stock artifact route does for one it creates. */
  grantWriters: (tx: ArtifactTx, row: ArtifactRow, scope: ResolvedPrincipal) => Promise<void>;
  schemaUrl: string;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

export type PolicyFileSync = { status: "synced" | "unchanged"; sha: string } | { status: "absent" } | { status: "invalid"; sha: string; reason: string };

function metadataWith(row: ArtifactRow | undefined, marker: FileMarker): Record<string, unknown> {
  return { ...asRecord(row?.metadata), policyFile: marker };
}

export function createPolicyFile(deps: PolicyFileDeps) {
  async function connectedRecord(tenantId: string, repo: string): Promise<RepoRecord | undefined> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    return repoRecords(triageNs(tenant?.config)).find((row) => row.name === repo && row.connected);
  }

  async function repoGithub(tenantId: string, record: RepoRecord): Promise<GithubFetch> {
    const gh = await deps.tenantGithub(tenantId);
    if (!gh) throw new Error("no active github credential");
    return forInstallation(gh, record.installationId);
  }

  async function store(tenantId: string, repo: string, content: string, marker: FileMarker, row: ArtifactRow | undefined): Promise<void> {
    const scope = { tenantId, principalId: await deps.writerFor(tenantId) };
    const metadata = metadataWith(row, marker);
    if (row) {
      await writeArtifactVersion(deps.artifacts, { scope, artifactId: row.id, content, metadata });
      return;
    }
    const title = checkPackName(repo);
    await deps.artifacts.transaction(async function createPolicy(tx) {
      const created = await createArtifact(tx, { scope, ownerPrincipalId: null, kind: "document", title, content, source: { origin: "workflow", producer: "policy-file" }, metadata: { ...metadata, checkPack: title } });
      await deps.grantWriters(tx, created, scope);
    });
  }

  /** Reads the file on the default branch and stores it when the hub's copy differs. A repository without the file is untouched. */
  async function sync(tenantId: string, record: RepoRecord): Promise<PolicyFileSync> {
    const repo = record.name;
    const file = await readRepoFile(await repoGithub(tenantId, record), repo, POLICY_FILE_PATH);
    if (!file) return { status: "absent" };
    let content: string;
    try {
      content = JSON.stringify(readPolicyFile(file.text, repo));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      deps.log({ level: "warn", msg: "policy_file_invalid", tenantId, repo, sha: file.sha, reason: error.message });
      return { status: "invalid", sha: file.sha, reason: error.message };
    }
    const row = await repoPolicyRow(deps, tenantId, repo);
    if (row && row.content === content && fileMarkerOf(row)?.sha === file.sha) return { status: "unchanged", sha: file.sha };
    await store(tenantId, repo, content, { path: POLICY_FILE_PATH, sha: file.sha, syncedAt: deps.now().toISOString(), contentSha256: createHash("sha256").update(content).digest("hex") }, row);
    deps.log({ level: "info", msg: "policy_file_synced", tenantId, repo, sha: file.sha });
    return { status: "synced", sha: file.sha };
  }

  /** Whether the repository holds the file and the hub's copy is what it says; undefined when there is no file. */
  async function status(tenantId: string, record: RepoRecord): Promise<PolicyFileStatus | undefined> {
    const repo = record.name;
    const file = await readRepoFile(await repoGithub(tenantId, record), repo, POLICY_FILE_PATH);
    if (!file) return undefined;
    const row = await repoPolicyRow(deps, tenantId, repo);
    const marker = row && fileMarkerOf(row);
    const base = { path: POLICY_FILE_PATH, sha: file.sha, url: file.url, ...(marker && { syncedAt: marker.syncedAt }) };
    try {
      return { ...base, inSync: row?.content === JSON.stringify(readPolicyFile(file.text, repo)) };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { ...base, inSync: false, problem: error.message };
    }
  }

  /** Syncs on a push to the default branch that touched the file. */
  async function onPush(tenantId: string, repo: string): Promise<PolicyFileSync | undefined> {
    const record = await connectedRecord(tenantId, repo);
    return record && sync(tenantId, record);
  }

  async function grantedRecord(member: Member, repo: string, action: "read" | "use"): Promise<RepoRecord | Response> {
    const grant = await githubAppGrant(deps, member.principalId, member.tenantId, action);
    if (grant instanceof Response) return grant;
    return (await connectedRecord(member.tenantId, repo)) ?? failure(409, "repo_not_connected", `${repo} is not connected to this workspace.`);
  }

  async function fileRoute({ repo }: typeof PolicyFileBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, repo, "read");
    if (record instanceof Response) return record;
    try {
      return Response.json({ file: (await status(member.tenantId, record)) ?? null });
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_file_status_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      return githubFailed(`read ${POLICY_FILE_PATH} from`, err);
    }
  }

  async function syncRoute({ repo }: typeof PolicyFileBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, repo, "use");
    if (record instanceof Response) return record;
    let synced: PolicyFileSync;
    try {
      synced = await sync(member.tenantId, record);
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_file_sync_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      return githubFailed(`read ${POLICY_FILE_PATH} from`, err);
    }
    if (synced.status === "absent") return failure(404, "policy_file_missing", `${repo} has no ${POLICY_FILE_PATH} on its default branch.`);
    if (synced.status === "invalid") return failure(422, "policy_file_invalid", synced.reason);
    return Response.json(synced);
  }

  async function exportRoute({ repo }: typeof PolicyFileBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, repo, "use");
    if (record instanceof Response) return record;
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
    try {
      const gh = await repoGithub(member.tenantId, record);
      if (await readRepoFile(gh, repo, POLICY_FILE_PATH)) return failure(409, "policy_file_exists", `${repo} already has ${POLICY_FILE_PATH}.`);
      const { default_branch: base } = await json(gh, `/repos/${repo}`);
      const head = await json(gh, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
      const created = await gh(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${EXPORT_BRANCH}`, sha: head.object.sha }) });
      if (created.status === 422) return failure(409, "policy_branch_exists", `${repo} already has a ${EXPORT_BRANCH} branch; merge or delete it first.`);
      if (!created.ok) throw new Error(`github POST /repos/${repo}/git/refs -> ${created.status}`);
      await json(gh, `/repos/${repo}/contents/${POLICY_FILE_PATH}`, {
        method: "PUT",
        body: JSON.stringify({ message: `chore: add ${POLICY_FILE_PATH}`, content: Buffer.from(text, "utf8").toString("base64"), branch: EXPORT_BRANCH }),
      });
      const pull = await json(gh, `/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: PR_TITLE, head: EXPORT_BRANCH, base, body: prBody(deps.schemaUrl) }) });
      deps.log({ level: "info", msg: "policy_file_exported", tenantId: member.tenantId, repo, number: pull.number });
      return Response.json({ status: "opened", url: pull.html_url, number: pull.number });
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_file_export_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      return githubFailed(`open a pull request adding ${POLICY_FILE_PATH} to`, err);
    }
  }

  return { onPush, fileRoute, syncRoute, exportRoute };
}

export type PolicyFile = ReturnType<typeof createPolicyFile>;
