// A repository's policy kept in `.corbits-triage.yml` (or `.yaml`) on its default branch. When the file is there, triage
// reads it as the policy in place of the stored one, and a file it refuses stops triage until it is fixed rather than
// falling back. Each read is kept in memory until a push to the default branch touches the file.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { asRecord, errorText } from "@corbits/common";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { json, readRepoFile, type GithubFetch, type RepoFileRead } from "@corbits/github-reads";
import { readRepo } from "../bitbucket-datacenter/client.js";
import { splitName } from "../bitbucket-datacenter/records.js";
import type { TenantBitbucket } from "../bitbucket-datacenter/tenant-bitbucket.js";
import { checkPolicyFile, POLICY_FILE_PATH, POLICY_FILE_PATHS, policyFileReason, policyFileText, type PolicyFileStatus } from "@corbits/triage-contracts";
import type { ArtifactDb } from "@corbits/artifacts";
import { repoPolicyRow } from "./check-pack-store.js";
import { forInstallation } from "./open-pulls.js";
import { failure, sourceCredentialGrant, type PortalCredentialDeps } from "./portal-credential.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./tenant-config.js";
import { githubFailed } from "./github-refusal.js";
import type { Member } from "../integrations/app.js";

export const PolicyFileBody = type({ repo: /^[\w.-]+\/[\w.-]+$/ });

export const EXPORT_BRANCH = "corbits-triage/policy";

const PR_TITLE = `chore: keep the Corbits Triage policy in ${POLICY_FILE_PATH}`;

const PR_BODY = [
  `Adds \`${POLICY_FILE_PATH}\` with this repository's current Corbits Triage policy.`,
  "",
  "Once merged, triage reads the policy from this file on the default branch, and the portal shows it read-only with a link here. Edit the policy by changing this file.",
].join("\n");

export type PolicyFileDeps = PortalCredentialDeps & {
  artifacts: ArtifactDb;
  /** GitHub as the tenant's App; undefined when the tenant has no active GitHub App credential. */
  tenantGithub: (tenantId: string) => Promise<GithubFetch | undefined>;
  tenantBitbucket: TenantBitbucket;
  log: (entry: Record<string, unknown>) => void;
};

/** The policy file on the default branch as triage takes it: none, refused with why, or the policy it holds. */
export type PolicyFileState =
  | { status: "absent" }
  | { status: "invalid"; path: string; reason: string; file?: PolicyFileStatus }
  | { status: "ok"; file: PolicyFileStatus; policy: Record<string, unknown> };

type FoundFile = { path: string; read: RepoFileRead };

function stateOf({ path, read }: FoundFile, repo: string): PolicyFileState {
  if (read.kind === "not-a-file") return { status: "invalid", path, reason: `${path} is not a file.` };
  const file = { path, sha: read.sha, url: read.url };
  if (read.text === null) return { status: "invalid", path, reason: `${path} is too large or uses aliases.`, file };
  const checked = checkPolicyFile(read.text, repo);
  if (!checked.ok) return { status: "invalid", path, reason: policyFileReason(checked.problems), file };
  return { status: "ok", file, policy: checked.policy };
}

export function createPolicyFile(deps: PolicyFileDeps) {
  const cache = new Map<string, Promise<PolicyFileState>>();

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

  async function readAt(tenantId: string, record: RepoRecord, path: string): Promise<RepoFileRead | undefined> {
    if (sourceOf(record) !== "bitbucket-datacenter") return readRepoFile(await repoGithub(tenantId, record), record.name, path);
    const bb = await deps.tenantBitbucket(tenantId);
    if (!bb) throw new Error("no active bitbucket-datacenter credential");
    return bitbucket.readRepoFile(bb, record.name, path, record.defaultBranch);
  }

  /** The first of the policy file's names found on the record's default branch. */
  async function findFile(tenantId: string, record: RepoRecord): Promise<FoundFile | undefined> {
    for (const path of POLICY_FILE_PATHS) {
      const read = await readAt(tenantId, record, path);
      if (read) return { path, read };
    }
    return undefined;
  }

  async function load(tenantId: string, record: RepoRecord): Promise<PolicyFileState> {
    const found = await findFile(tenantId, record);
    const state = found ? stateOf(found, record.name) : { status: "absent" as const };
    if (state.status === "invalid") deps.log({ level: "warn", msg: "policy_file_invalid", tenantId, repo: record.name, path: state.path, reason: state.reason });
    return state;
  }

  /** A failed read is not kept, so the next trigger reads again rather than run on a stale answer. */
  async function cached(tenantId: string, record: RepoRecord, fresh: boolean): Promise<PolicyFileState> {
    const key = `${tenantId}\n${record.name}`;
    const kept = fresh ? undefined : cache.get(key);
    if (kept) return kept;
    const pending = load(tenantId, record);
    cache.set(key, pending);
    try {
      return await pending;
    } catch (err) {
      if (cache.get(key) === pending) cache.delete(key);
      throw err;
    }
  }

  /** The repository's policy file as triage takes it; absent when the repository is not connected. */
  async function current(tenantId: string, repo: string): Promise<PolicyFileState> {
    const record = await connectedRecord(tenantId, repo);
    return record ? cached(tenantId, record, false) : { status: "absent" };
  }

  /** A push to the default branch that touched the file reads it again; undefined when the repository is not connected. */
  async function onPush(tenantId: string, repo: string): Promise<PolicyFileState | undefined> {
    const record = await connectedRecord(tenantId, repo);
    return record && cached(tenantId, record, true);
  }

  async function grantedRecord(member: Member, repo: string, action: "read" | "use"): Promise<RepoRecord | Response> {
    const record = await connectedRecord(member.tenantId, repo);
    if (!record) return failure(409, "repo_not_connected", `${repo} is not connected to this workspace.`);
    return (await sourceCredentialGrant(deps, member.principalId, member.tenantId, record, action)) ?? record;
  }

  function statusOf(state: PolicyFileState): PolicyFileStatus | null | Response {
    if (state.status === "absent") return null;
    if (state.status === "ok") return state.file;
    return state.file ? { ...state.file, problem: state.reason } : failure(422, "policy_file_invalid", state.reason);
  }

  async function fileRoute({ repo }: typeof PolicyFileBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, repo, "read");
    if (record instanceof Response) return record;
    let state: PolicyFileState;
    try {
      state = await cached(member.tenantId, record, false);
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_file_status_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      return githubFailed(`read ${POLICY_FILE_PATH} from`, err);
    }
    const file = statusOf(state);
    return file instanceof Response ? file : Response.json({ file });
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
    const text = policyFileText(stored);
    let gh: GithubFetch | undefined;
    let branched = false;
    try {
      gh = await repoGithub(member.tenantId, record);
      if (await findFile(member.tenantId, record)) return failure(409, "policy_file_exists", `${repo} already has a policy file.`);
      const { default_branch: base } = await json(gh, `/repos/${repo}`);
      // Unverified against GitHub for a default branch whose name holds a slash.
      const head = await json(gh, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
      branched = await createBranch(gh, repo, head.object.sha);
      if (!branched) return failure(409, "policy_branch_exists", `${repo} already has a ${EXPORT_BRANCH} branch; merge or delete it first.`);
      await json(gh, `/repos/${repo}/contents/${POLICY_FILE_PATH}`, {
        method: "PUT",
        body: JSON.stringify({ message: `chore: add ${POLICY_FILE_PATH}`, content: Buffer.from(text, "utf8").toString("base64"), branch: EXPORT_BRANCH }),
      });
      const pull = await json(gh, `/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: PR_TITLE, head: EXPORT_BRANCH, base, body: PR_BODY }) });
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

  return { current, onPush, fileRoute, exportRoute };
}

export type PolicyFile = ReturnType<typeof createPolicyFile>;
