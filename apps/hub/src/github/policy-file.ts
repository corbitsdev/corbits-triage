// A repository's policy kept in `.corbits-triage.yml` (or `.yaml`) on its default branch. When the file is there, triage
// reads it as the policy unless the repository's saved rules run differently (see check-pack-store.ts), and a file it
// refuses stops triage until it is fixed rather than falling back. Each read is kept in memory until a push to the
// default branch touches the file. Saved rules are written to the file through a pull request (policy-pull.ts).
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { errorText } from "@corbits/common";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { readRepoFile, type GithubFetch, type RepoFileRead } from "@corbits/github-reads";
import { defaultBranch, readRepo } from "../bitbucket-datacenter/client.js";
import * as bitbucketPull from "../bitbucket-datacenter/policy-pull.js";
import { splitName } from "../bitbucket-datacenter/records.js";
import type { TenantBitbucket } from "../bitbucket-datacenter/tenant-bitbucket.js";
import { checkPolicyFile, exportPolicyFile, POLICY_FILE_PATH, POLICY_FILE_PATHS, policyFileReason, type PolicyFileStatus, type PolicyUpgrades, type RepoSource } from "@corbits/triage-contracts";
import type { PolicySettled } from "./check-pack-store.js";
import { forInstallation } from "./open-pulls.js";
import * as github from "./policy-pull.js";
import { failure, sourceCredentialGrant, type PortalCredentialDeps } from "./portal-credential.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./tenant-config.js";
import { bitbucketFailed, githubFailed } from "./github-refusal.js";
import type { Member } from "../integrations/app.js";

export const PolicyFileBody = type({ repo: /^[\w.-]+\/[\w.-]+$/ });

const HOST_NAMES: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket" };

type PolicyUpgradeRow = PolicyUpgrades["repos"][number];

/** What the pull request does, in the words a maintainer reviewing it reads. */
function pullBody(state: "upgrade" | "differs", path: string, unexpressed: readonly string[]): string {
  const lead = state === "upgrade"
    ? [`Writes the rules saved in Corbits Triage to \`${path}\`.`, "", "The saved rules keep applying until this pull request is merged."]
    : [`Makes \`${path}\` match the rules saved in Corbits Triage, which apply until the two agree.`];
  const left = unexpressed.length ? ["", "A policy file can't hold everything the saved rules do:", ...unexpressed.map((line) => `- ${line}`)] : [];
  return [...lead, "", "Once merged, triage reads its rules from this file, and you change them by editing it.", ...left].join("\n");
}

export type PolicyFileDeps = PortalCredentialDeps & {
  /** The repository's policy and how its saved rules stand against its file. */
  settle: (tenantId: string, repo: string) => Promise<PolicySettled>;
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

  async function repoBitbucket(tenantId: string): Promise<bitbucket.BitbucketFetch> {
    const bb = await deps.tenantBitbucket(tenantId);
    if (!bb) throw new Error("no active bitbucket-datacenter credential");
    return bb;
  }

  async function readAt(tenantId: string, record: RepoRecord, path: string): Promise<RepoFileRead | undefined> {
    if (sourceOf(record) !== "bitbucket-datacenter") return readRepoFile(await repoGithub(tenantId, record), record.name, path);
    return bitbucket.readRepoFile(await repoBitbucket(tenantId), record.name, path, record.defaultBranch);
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

  async function bitbucketBase(bb: bitbucket.BitbucketFetch, record: RepoRecord): Promise<string> {
    const base = record.defaultBranch ?? (await defaultBranch(bb, ...splitName(record.name)));
    if (base === undefined) throw new Error(`${record.name} has no default branch`);
    return base;
  }

  async function openPull(tenantId: string, record: RepoRecord): Promise<github.PolicyPull | undefined> {
    if (sourceOf(record) === "github") return github.openPolicyPull(await repoGithub(tenantId, record), record.name);
    return bitbucketPull.openPolicyPull(await repoBitbucket(tenantId), record.name);
  }

  async function propose(tenantId: string, record: RepoRecord, change: github.PolicyChange): Promise<github.PolicyPull> {
    if (sourceOf(record) === "github") return github.proposePolicy(await repoGithub(tenantId, record), record.name, change);
    const bb = await repoBitbucket(tenantId);
    return bitbucketPull.proposePolicy(bb, record.name, await bitbucketBase(bb, record), change);
  }

  /** Opens the pull request writing the saved rules to the policy file, or brings the open one up to date; refused when nothing differs. */
  async function exportRoute({ repo }: typeof PolicyFileBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, repo, "use");
    if (record instanceof Response) return record;
    try {
      const { upgrade, saved } = await deps.settle(member.tenantId, repo);
      if (upgrade.state === "ok" || !saved) return failure(409, "policy_settled", `${repo} has no saved rules apart from its policy file.`);
      if (upgrade.state === "differs" && !upgrade.fixable) return failure(409, "policy_file_full", `${repo}'s policy file already holds all of its saved rules that a file can; keep the file to settle it.`);
      const path = upgrade.state === "differs" ? upgrade.path : POLICY_FILE_PATH;
      const { text, unexpressed } = exportPolicyFile(saved.pack, saved.source.shared !== undefined);
      const pull = await propose(member.tenantId, record, { path, text, title: `chore: keep the Corbits Triage rules in ${path}`, body: pullBody(upgrade.state, path, unexpressed) });
      deps.log({ level: "info", msg: "policy_file_exported", tenantId: member.tenantId, repo, number: pull.number });
      return Response.json({ status: "opened", ...pull });
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_file_export_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      const what = `open the pull request writing ${repo}'s saved rules to its policy file`;
      return sourceOf(record) === "github" ? githubFailed(what, err) : bitbucketFailed(what, err);
    }
  }

  async function upgradeOf(member: Member, record: RepoRecord): Promise<PolicyUpgradeRow | undefined> {
    if (await sourceCredentialGrant(deps, member.principalId, member.tenantId, record, "read")) return undefined;
    try {
      const { upgrade } = await deps.settle(member.tenantId, record.name);
      if (upgrade.state === "ok") return { repo: record.name, upgrade };
      const pull = await openPull(member.tenantId, record);
      return { repo: record.name, upgrade, ...(pull && { pull }) };
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_upgrade_read_failed", tenantId: member.tenantId, repo: record.name, error: errorText(err) });
      return { repo: record.name, error: `Could not read ${record.name}'s policy from ${HOST_NAMES[sourceOf(record)]}.` };
    }
  }

  /** How each enabled repository the member may read stands: see `settlePolicy`. */
  async function upgradesRoute(member: Member): Promise<Response> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, member.tenantId), columns: { config: true } });
    const records = repoRecords(triageNs(tenant?.config)).filter((record) => record.connected && record.enabled);
    const rows = await Promise.all(records.map((record) => upgradeOf(member, record)));
    return Response.json({ repos: rows.filter((row) => row !== undefined) });
  }

  return { current, onPush, fileRoute, exportRoute, upgradesRoute };
}

export type PolicyFile = ReturnType<typeof createPolicyFile>;
