// A repository's policy is `.corbits-triage.yml` (or `.yaml`) on its default branch, the only place it is kept; a file
// triage refuses stops triage until it is fixed. Each read is kept in memory until a push to the default branch touches
// the file, or for a minute while its webhook is not heard. A starter policy or edited text reaches the file through a
// pull request (policy-pull.ts), or as one commit straight to the default branch where the branch lets the hub push
// (policy-push.ts).
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { errorText } from "@corbits/common";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { readRepoFile, type GithubFetch, type RepoFileRead } from "@corbits/github-reads";
import { defaultBranch, readRepo } from "../bitbucket-datacenter/client.js";
import * as bitbucketPull from "../bitbucket-datacenter/policy-pull.js";
import { bitbucketPushAccess, pushBitbucketPolicy } from "../bitbucket-datacenter/policy-push.js";
import { bitbucketConnection, splitName } from "../bitbucket-datacenter/records.js";
import type { TenantBitbucket } from "../bitbucket-datacenter/tenant-bitbucket.js";
import { checkPolicyFile, exportPolicyFile, fileRuleId, patchPolicyFile, POLICY_FILE_PATH, PolicyPatchChanges, notAFileReason, POLICY_FILE_PATHS, policyFileReason, REPO_SOURCES, starterPack, type ActionKind, type PolicyFileStatus, type PolicyPatchChange, type PolicyPushAccess, type PolicyUpgrades, type PolicyWorkflow, type RepoSource } from "@corbits/triage-contracts";
import { forInstallation, type MemberOpenPulls, type OpenPullsRead, type RepoPulls } from "./open-pulls.js";
import * as github from "./policy-pull.js";
import { githubPushAccess, pushGithubPolicy, type PolicyPush, type Pushed } from "./policy-push.js";
import { failure, sourceCredentialGrant, type PortalCredentialDeps } from "./portal-credential.js";
import type { RepoActivity } from "./repo-activity.js";
import type { RepoReads } from "./repo-reads.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./tenant-config.js";
import { bitbucketFailed, githubFailed } from "./github-refusal.js";
import { createKeyedSerial } from "../keyed-serial.js";
import type { Member } from "../integrations/app.js";

export const PolicyFileBody = type({ repo: /^[\w.-]+\/[\w.-]+$/, "source?": type.enumerated(...REPO_SOURCES) });
/** `sha` is the file's sha the text was edited from, null when there was no file; a file that has changed since is refused. */
export const PolicyExportBody = PolicyFileBody.and({ "text?": "string", "sha?": "string | null" });
export const PolicyPatchBody = PolicyFileBody.and({ changes: PolicyPatchChanges, "preview?": "boolean" });
export const PolicyPushBody = PolicyFileBody.and({ text: "string", sha: "string" });

const HOST_NAMES: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket" };

type PolicyUpgradeRow = PolicyUpgrades["repos"][number];

function optionValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function changeSentence(change: PolicyPatchChange): string {
  switch (change.kind) {
    case "rule":
      return `${change.enabled ? "Turns on" : "Turns off"} \`${change.id}\`.`;
    case "rule-options":
      return `Sets ${Object.entries(change.options).map(([key, value]) => `\`${change.id}\` ${key} to ${optionValue(value)}`).join(", ")}.`;
    case "add-rule":
      return `Adds the rule \`${fileRuleId(change.rule)}\`.`;
    case "remove-rule":
      return `Removes the rule \`${change.id}\`.`;
    case "code-review":
      return `${change.on ? "Turns on" : "Turns off"} code review.`;
    case "strip-reserved":
      return "Removes the security and deslop blocks, and the decide rules with a condition on one, which Triage skips.";
  }
}

/** What one batch changes, in the words a maintainer reviewing it reads; an open pull request gets it added to its body. */
function patchPullBody(path: string, changes: readonly PolicyPatchChange[]): string {
  return [`Updates the rules in \`${path}\`:`, "", ...changes.map((change) => `- ${changeSentence(change)}`)].join("\n");
}

/** Kept short: the kinds by the names the file writes them in. */
function waitingNote(kinds: readonly ActionKind[]): string {
  return `Once merged, these wait for approval on Corbits Triage each time they run: ${kinds.map((kind) => `\`${kind}\``).join(", ")}.`;
}

const ADD_TITLE = `chore: add a Corbits Triage policy in ${POLICY_FILE_PATH}`;

function addBody(lead: string): string {
  return [lead, "", "Edit it here before merging. Once merged, triage reads its rules from this file, and you change them by editing it."].join("\n");
}

const STARTER_BODY = addBody(`Adds \`${POLICY_FILE_PATH}\` with a few common rules: a size limit, no merge conflicts, passing CI, and a maintainer asked about sensitive or risky changes.`);
const CHOSEN_BODY = addBody(`Adds \`${POLICY_FILE_PATH}\`.`);

function editedBody(path: string): string {
  return [`Updates the rules in \`${path}\` as edited in Corbits Triage.`, "", "Once merged, triage runs on the new rules."].join("\n");
}

function fileMoved(path: string): Response {
  return failure(409, "policy_file_changed", `${path} changed since it was read; load it again and redo the change.`);
}

function hostFailed(record: RepoRecord, what: string, err: unknown): Response {
  return sourceOf(record) === "github" ? githubFailed(what, err) : bitbucketFailed(what, err);
}

/**
 * A repository's open policy pull request, found in the shared listing so a workspace costs no host calls per repository
 * on each load. A member the listing refuses is not told of one; opening the pull request answers it.
 */
export function listedPolicyPull(listing: OpenPullsRead | Response, repo: string, source: RepoSource): github.PolicyPull | undefined {
  const pr = listedPolicyRow(listing, repo, source);
  if (!pr?.url) return undefined;
  // Only a GitHub pull request is merged from the portal, at the head it was shown.
  return source === "github" && pr.sha ? { url: pr.url, number: pr.number, headSha: pr.sha } : { url: pr.url, number: pr.number };
}

function listedPolicyRow(listing: OpenPullsRead | Response, repo: string, source: RepoSource): RepoPulls["prs"][number] | undefined {
  if (listing instanceof Response) return undefined;
  return listing.repos.find((row) => row.repo === repo && row.source === source)?.prs.find((row) => row.branch === github.POLICY_BRANCH);
}

export type PolicyFileDeps = PortalCredentialDeps & {
  /** Why triage would refuse a policy file holding `policy`, its `extends` resolved; undefined when it would run it. */
  refusal: (tenantId: string, repo: string, source: RepoSource, policy: Record<string, unknown>) => Promise<string | undefined>;
  /** GitHub as the tenant's App; undefined when the tenant has no active GitHub App credential. */
  tenantGithub: (tenantId: string) => Promise<GithubFetch | undefined>;
  tenantBitbucket: TenantBitbucket;
  /** The workspace's shared open pull request listing; `fresh` lists again. */
  openPulls: MemberOpenPulls;
  changed: RepoReads["changed"];
  log: (entry: Record<string, unknown>) => void;
  /** Whether the repository's webhook (the App's, on GitHub) has been silent long enough that a push may go unheard. */
  quiet: RepoActivity["quiet"];
  /** The kinds a policy file holding `text` uses that will wait for a person once it is merged. */
  waitingKinds: (tenantId: string, repo: string, source: RepoSource, text: string) => Promise<ActionKind[]>;
};

/** The policy file on the default branch as triage takes it: none, refused with why, or the policy it holds. */
export type PolicyFileState =
  | { status: "absent" }
  | { status: "invalid"; path: string; reason: string; file?: PolicyFileStatus }
  | { status: "ok"; file: PolicyFileStatus; policy: Record<string, unknown>; workflow: PolicyWorkflow };

type FoundFile = { path: string; read: RepoFileRead };
type CachedFile = { read: Promise<PolicyFileState>; at: number; settled?: PolicyFileState };

function stateOf({ path, read }: FoundFile, repo: string): PolicyFileState {
  if (read.kind === "not-a-file") return { status: "invalid", path, reason: notAFileReason(path) };
  if (read.text === null) return { status: "invalid", path, reason: `${path} is too large or uses aliases.`, file: { path, sha: read.sha, url: read.url } };
  const file = { path, sha: read.sha, url: read.url, text: read.text };
  const checked = checkPolicyFile(read.text, repo);
  if (!checked.ok) return { status: "invalid", path, reason: policyFileReason(checked.problems), file };
  return { status: "ok", file: { ...file, ...(checked.pending && { pending: policyFileReason(checked.pending) }) }, policy: checked.policy, workflow: checked.workflow };
}

/** How long a read of a repository whose webhook the hub has not heard lately is kept. */
const UNHEARD_MAX_AGE_MS = 60_000;

export function createPolicyFile(deps: PolicyFileDeps) {
  /** `settled` is the read once it is answered, so a grant can tell whether a newer read overtook its own. */
  const cache = new Map<string, CachedFile>();
  /** One repository's policy pull request writes, so each one's read, commit and body edit finish before the next reads. */
  const serialized = createKeyedSerial();

  function repoKey(tenantId: string, record: RepoRecord): string {
    return `${tenantId}\n${sourceOf(record)}\n${record.name}`;
  }

  /**
   * A read is kept until a push re-reads it while the repository's webhook is heard; where it is not (a hub the host
   * cannot reach, a broken webhook, a restart before any delivery, a Bitbucket repository not yet enabled) a merged file
   * would otherwise never be seen.
   */
  function maxAgeOf(tenantId: string, record: RepoRecord): number {
    return deps.quiet(tenantId, sourceOf(record), record.name) ? UNHEARD_MAX_AGE_MS : Infinity;
  }

  /** A Bitbucket repository the token sees has no record until it is enabled, so rules can be written for it first, as for GitHub. */
  async function visibleBitbucketRecord(tenantId: string, repo: string): Promise<RepoRecord | undefined> {
    const bb = await deps.tenantBitbucket(tenantId);
    if (!bb || !(await readRepo(bb, ...splitName(repo)))) return undefined;
    return { name: repo, source: "bitbucket-datacenter", connected: true };
  }

  /**
   * The connected record for `repo` on `source`. A caller that cannot name the host gets none where both hosts hold the
   * name, so one host's policy is never read for the other's repository.
   */
  async function connectedRecord(tenantId: string, repo: string, source: RepoSource | undefined): Promise<RepoRecord | undefined> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    const named = repoRecords(triageNs(tenant?.config)).filter((row) => row.name === repo && row.connected && (source === undefined || sourceOf(row) === source));
    if (named.length > 1) return undefined;
    if (named[0]) return named[0];
    return source === "github" ? undefined : visibleBitbucketRecord(tenantId, repo);
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

  async function readAt(tenantId: string, record: RepoRecord, path: string, branch?: string): Promise<RepoFileRead | undefined> {
    if (sourceOf(record) !== "bitbucket-datacenter") return readRepoFile(await repoGithub(tenantId, record), record.name, path, branch);
    return bitbucket.readRepoFile(await repoBitbucket(tenantId), record.name, path, branch ?? record.defaultBranch);
  }

  /** The first of the policy file's names found on `branch`, else on the record's default branch. */
  async function findFile(tenantId: string, record: RepoRecord, branch?: string): Promise<FoundFile | undefined> {
    for (const path of POLICY_FILE_PATHS) {
      const read = await readAt(tenantId, record, path, branch);
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
  async function cached(tenantId: string, record: RepoRecord, maxAgeMs: number): Promise<PolicyFileState> {
    const key = repoKey(tenantId, record);
    const kept = cache.get(key);
    if (kept && Date.now() - kept.at < maxAgeMs) return kept.read;
    const entry: CachedFile = { read: load(tenantId, record), at: Date.now() };
    cache.set(key, entry);
    try {
      entry.settled = await entry.read;
      return entry.settled;
    } catch (err) {
      if (cache.get(key) === entry) cache.delete(key);
      throw err;
    }
  }

  /** The repository's policy file as triage takes it; absent when the repository is not connected. */
  async function current(tenantId: string, repo: string, source: RepoSource | undefined): Promise<PolicyFileState> {
    const record = await connectedRecord(tenantId, repo, source);
    return record ? cached(tenantId, record, maxAgeOf(tenantId, record)) : { status: "absent" };
  }

  /**
   * Whether the file at `sha` is still the newest read of the repository's policy file: false while a newer read is
   * under way or once one found another file, which grants in its turn.
   */
  function isNewest(tenantId: string, repo: string, source: RepoSource, sha: string): boolean {
    const kept = cache.get(repoKey(tenantId, { name: repo, source, connected: true }));
    if (!kept) return true;
    return kept.settled?.status === "ok" && kept.settled.file.sha === sha;
  }

  /** A push to the default branch that touched the file reads it again; undefined when the repository is not connected. */
  async function onPush(tenantId: string, repo: string, source: RepoSource): Promise<PolicyFileState | undefined> {
    const record = await connectedRecord(tenantId, repo, source);
    return record && cached(tenantId, record, 0);
  }

  async function grantedRecord(member: Member, repo: string, source: RepoSource | undefined, action: "read" | "use"): Promise<RepoRecord | Response> {
    const record = await connectedRecord(member.tenantId, repo, source);
    if (!record) return failure(409, "repo_not_connected", source === undefined ? `${repo} is not connected to this workspace, or is connected from both hosts.` : `${repo} is not connected to this workspace.`);
    return (await sourceCredentialGrant(deps, member.principalId, member.tenantId, record, action)) ?? record;
  }

  function statusOf(state: PolicyFileState): PolicyFileStatus | null | Response {
    if (state.status === "absent") return null;
    if (state.status === "ok") return state.file;
    return state.file ? { ...state.file, problem: state.reason } : failure(422, "policy_file_invalid", state.reason);
  }

  async function fileRoute({ repo, source }: typeof PolicyFileBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, repo, source, "read");
    if (record instanceof Response) return record;
    try {
      const file = statusOf(await cached(member.tenantId, record, maxAgeOf(member.tenantId, record)));
      if (file instanceof Response) return file;
      const pull = file && await pullCopy(member, record);
      return Response.json({ file: pull ? { ...file, pull } : file });
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_file_status_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      return githubFailed(`read ${POLICY_FILE_PATH} from`, err);
    }
  }

  /**
   * The open policy pull request's copy of the file, found through the shared listing; none while its branch holds no
   * readable file, or cannot be read, which leaves the default branch's file to answer on its own.
   */
  async function pullCopy(member: Member, record: RepoRecord): Promise<PolicyFileStatus["pull"]> {
    const pr = listedPolicyRow(await deps.openPulls(member, false), record.name, sourceOf(record));
    if (!pr?.sha) return undefined;
    try {
      const found = await findFile(member.tenantId, record, github.POLICY_BRANCH);
      if (found?.read.kind !== "file" || found.read.text === null) return undefined;
      return { text: found.read.text, headSha: pr.sha };
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_pull_file_read_failed", tenantId: member.tenantId, repo: record.name, error: errorText(err) });
      return undefined;
    }
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

  async function opened(member: Member, record: RepoRecord, change: github.PolicyChange, msg = "policy_file_exported"): Promise<Response> {
    const { tenantId } = member;
    const waiting = await deps.waitingKinds(tenantId, record.name, sourceOf(record), change.text);
    const body = waiting.length === 0 ? change.body : [change.body, "", waitingNote(waiting)].join("\n");
    const pull = await propose(tenantId, record, { ...change, body });
    deps.log({ level: "info", msg, tenantId, repo: record.name, number: pull.number });
    // The listing is where the repository's standing and the upgrades read find the new pull request.
    deps.changed(tenantId, record.name);
    await deps.openPulls(member, true);
    return Response.json({ status: "opened", ...pull });
  }

  /** An open pull request may already hold the maintainer's edits to the starter, so it is answered as it is. */
  async function startFile(member: Member, record: RepoRecord): Promise<Response> {
    const pull = await openPull(member.tenantId, record);
    if (pull) return Response.json({ status: "opened", ...pull });
    return opened(member, record, { path: POLICY_FILE_PATH, text: exportPolicyFile(starterPack(record.name)).text, title: ADD_TITLE, body: STARTER_BODY });
  }

  /** Why triage would refuse `text` as the repository's policy file, its `extends` resolved; undefined when it would run it. */
  async function textRefusal(tenantId: string, record: RepoRecord, text: string): Promise<Response | undefined> {
    const checked = checkPolicyFile(text, record.name);
    if (!checked.ok) return failure(422, "policy_file_invalid", policyFileReason(checked.problems));
    if (checked.pending) return failure(422, "policy_file_invalid", policyFileReason(checked.pending));
    const refusal = await deps.refusal(tenantId, record.name, sourceOf(record), checked.policy);
    return refusal === undefined ? undefined : failure(422, "policy_file_invalid", refusal);
  }

  /** The default branch's file, read past the kept read: a file merged where no push is heard is not in it. */
  async function freshFile(tenantId: string, record: RepoRecord): Promise<PolicyFileStatus | null | Response> {
    const state = await cached(tenantId, record, 0);
    if (state.status === "absent") return null;
    if (state.status === "ok") return state.file;
    return state.file ?? failure(422, "policy_file_invalid", state.reason);
  }

  /**
   * `text` through the policy pull request: a new file where there is none, else over the file at its own path. Refused
   * as triage would refuse it once merged, and when the file is no longer the one `sha` names. An open pull request may
   * hold the maintainer's edits, so it is never written over.
   */
  async function chosenFile(member: Member, record: RepoRecord, text: string, sha: string | null): Promise<Response> {
    const refused = await textRefusal(member.tenantId, record, text);
    if (refused) return refused;
    const pull = await openPull(member.tenantId, record);
    if (pull) return failure(409, "policy_pull_open", `${record.name}'s policy pull request is open; merge or close it first.`, pull);
    const file = await freshFile(member.tenantId, record);
    if (file instanceof Response) return file;
    if ((file?.sha ?? null) !== sha) return fileMoved(file?.path ?? POLICY_FILE_PATH);
    if (!file) return opened(member, record, { path: POLICY_FILE_PATH, text, title: ADD_TITLE, body: CHOSEN_BODY, readSha: null });
    if (file.text === text) return failure(409, "policy_file_unchanged", `${file.path} already holds this text.`);
    return opened(member, record, { path: file.path, text, title: `chore: update the Corbits Triage rules in ${file.path}`, body: editedBody(file.path), readSha: file.sha });
  }

  /**
   * Opens the pull request writing `text` to the policy file (see `chosenFile`), or, without it, the pull request adding
   * the starter policy to a repository with no file.
   */
  async function exportRoute(body: typeof PolicyExportBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, body.repo, body.source, "use");
    if (record instanceof Response) return record;
    return serialized(repoKey(member.tenantId, record), function exportOne() {
      return exportRecord(body, member, record);
    });
  }

  async function exportRecord({ repo, text: chosen, sha }: typeof PolicyExportBody.infer, member: Member, record: RepoRecord): Promise<Response> {
    try {
      if (chosen !== undefined) {
        // Without the sha the text was edited from, a file changed meanwhile would be overwritten unseen.
        if (sha === undefined) return failure(400, "invalid_request", "Send the sha of the policy file the text was edited from, or null for a repository with no file.");
        return await chosenFile(member, record, chosen, sha);
      }
      if ((await cached(member.tenantId, record, 0)).status !== "absent") return failure(409, "policy_file_present", `${repo} already has a policy file; change it by editing it.`);
      return await startFile(member, record);
    } catch (err) {
      if (err instanceof github.PolicyFileMoved) return fileMoved(err.path);
      deps.log({ level: "warn", msg: "policy_file_export_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      return hostFailed(record, `open the pull request writing ${repo}'s policy file`, err);
    }
  }

  async function pushAccessOf(tenantId: string, record: RepoRecord): Promise<PolicyPushAccess> {
    if (sourceOf(record) === "github") return githubPushAccess(await repoGithub(tenantId, record), record.name);
    const bb = await repoBitbucket(tenantId);
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    return bitbucketPushAccess(bb, record.name, await bitbucketBase(bb, record), bitbucketConnection(triageNs(tenant?.config))?.user);
  }

  /** Whether the hub may push the policy file straight to the default branch, as the host's branch rules answer it. */
  async function pushAccessRoute({ repo, source }: typeof PolicyFileBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, repo, source, "use");
    if (record instanceof Response) return record;
    try {
      return Response.json(await pushAccessOf(member.tenantId, record));
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_push_access_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      return hostFailed(record, `show the branch rules of ${repo}`, err);
    }
  }

  async function push(tenantId: string, record: RepoRecord, change: PolicyPush): Promise<Pushed> {
    if (sourceOf(record) === "github") return pushGithubPolicy(await repoGithub(tenantId, record), record.name, change);
    return pushBitbucketPolicy(await repoBitbucket(tenantId), record.name, change);
  }

  /** A push skips review and can let Triage approve or merge on its own, so it needs what granting Triage a kind needs, or managing the workspace. */
  async function pushRefusal({ principalId, tenantId }: Member): Promise<Response | undefined> {
    if (await deps.authorize(principalId, tenantId, "grant:*", "create")) return undefined;
    if (await deps.authorize(principalId, tenantId, `tenant:${tenantId}`, "manage")) return undefined;
    return failure(403, "forbidden", "You may not push the policy file straight to the default branch. Create a pull request instead.");
  }

  /**
   * Commits `text` over the policy file on the default branch, as one commit with a fixed message. Refused as triage
   * would refuse the file, where the branch's rules would not let the hub push, and when the file is no longer the one
   * `sha` names.
   */
  async function pushRoute(body: typeof PolicyPushBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, body.repo, body.source, "use");
    if (record instanceof Response) return record;
    const refused = await pushRefusal(member);
    if (refused) return refused;
    return serialized(repoKey(member.tenantId, record), function pushOne() {
      return pushRecord(body, member, record);
    });
  }

  async function pushRecord({ repo, text, sha }: typeof PolicyPushBody.infer, member: Member, record: RepoRecord): Promise<Response> {
    try {
      const refused = await textRefusal(member.tenantId, record, text);
      if (refused) return refused;
      const access = await pushAccessOf(member.tenantId, record);
      if (!access.allowed) return failure(409, "push_refused", access.reason);
      const file = await freshFile(member.tenantId, record);
      if (file instanceof Response) return file;
      if (file?.sha !== sha) return fileMoved(file?.path ?? POLICY_FILE_PATH);
      if (file.text === text) return failure(409, "policy_file_unchanged", `${file.path} already holds this text.`);
      const pushed = await push(member.tenantId, record, { branch: access.branch, path: file.path, text, sha });
      deps.log({ level: "info", msg: "policy_file_pushed_from_portal", tenantId: member.tenantId, principalId: member.principalId, repo, path: file.path, commit: pushed.commit });
      // The push's webhook reads the file again; until it is heard, the kept read would be the file before.
      cache.delete(repoKey(member.tenantId, record));
      deps.changed(member.tenantId, record.name);
      return Response.json({ status: "pushed", path: file.path, ...pushed });
    } catch (err) {
      if (err instanceof github.PolicyFileMoved) return fileMoved(err.path);
      deps.log({ level: "warn", msg: "policy_file_push_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      return hostFailed(record, `push ${repo}'s policy file`, err);
    }
  }

  function textOfFound(found: FoundFile): { text: string; sha: string } | Response {
    if (found.read.kind === "not-a-file") return failure(422, "policy_file_invalid", notAFileReason(found.path));
    if (found.read.text === null) return failure(422, "policy_file_invalid", `${found.path} is too large or uses aliases.`);
    return { text: found.read.text, sha: found.read.sha };
  }

  /**
   * The file to patch and the sha to commit against. Without a policy pull request the branch starts from the default
   * branch, so its sha holds. With one open, its branch's file wins so edits there survive; a branch without one takes
   * the default branch's text and is committed as a new file (sha null).
   */
  async function policySource(tenantId: string, record: RepoRecord): Promise<{ path: string; text: string; sha: string | null } | Response> {
    const pull = await openPull(tenantId, record);
    const onBranch = pull ? await findFile(tenantId, record, github.POLICY_BRANCH) : undefined;
    const found = onBranch ?? await findFile(tenantId, record);
    if (!found) return failure(409, "policy_file_absent", `${record.name} has no policy file. Open one with the export route before changing it.`);
    const read = textOfFound(found);
    if (read instanceof Response) return read;
    return { path: found.path, text: read.text, sha: pull && !onBranch ? null : read.sha };
  }

  /**
   * Patches the existing policy file in place and opens the one policy pull request, or adds the batch to the open one,
   * whose title and earlier batches stay. `preview` returns the file before and after and writes nothing. Refused when
   * there is no file, or the batch or the file is refused.
   */
  async function patchRoute(body: typeof PolicyPatchBody.infer, member: Member): Promise<Response> {
    const record = await grantedRecord(member, body.repo, body.source, "use");
    if (record instanceof Response) return record;
    return serialized(repoKey(member.tenantId, record), function patchOne() {
      return patchRecord(body, member, record);
    });
  }

  async function patchRecord({ repo, changes, preview }: typeof PolicyPatchBody.infer, member: Member, record: RepoRecord): Promise<Response> {
    try {
      const found = await policySource(member.tenantId, record);
      if (found instanceof Response) return found;
      const patched = patchPolicyFile(found.text, record.name, changes);
      if (!patched.ok) return failure(422, "policy_file_invalid", patched.message);
      // A batch that changes nothing writes nothing; a pull request for it alone would have no commits to show.
      if (!patched.changed) return Response.json({ before: found.text, after: found.text });
      if (preview === true) return Response.json({ before: found.text, after: patched.text });
      return await opened(member, record, {
        path: found.path,
        text: patched.text,
        title: `chore: update the Corbits Triage rules in ${found.path}`,
        body: patchPullBody(found.path, changes),
        append: true,
        readSha: found.sha,
      }, "policy_file_patched");
    } catch (err) {
      if (err instanceof github.PolicyFileMoved) return failure(409, "policy_file_changed", `${err.path} changed since it was read; send the changes again.`);
      if (err instanceof github.DescriptionNotUpdated) {
        deps.log({ level: "warn", msg: "policy_pull_description_failed", tenantId: member.tenantId, repo, commit: err.commit, error: errorText(err.reason) });
        const landed = err.commit === undefined ? "The change is on the policy pull request" : `Commit ${err.commit} landed on the policy pull request`;
        return failure(502, "description_not_updated", `${landed}, but its description could not be updated; the next change to this policy adds it.`);
      }
      deps.log({ level: "warn", msg: "policy_file_patch_failed", tenantId: member.tenantId, repo, error: errorText(err) });
      const what = `open the pull request updating ${repo}'s policy file`;
      return sourceOf(record) === "github" ? githubFailed(what, err) : bitbucketFailed(what, err);
    }
  }

  async function upgradeOf(member: Member, record: RepoRecord, listed: () => Promise<OpenPullsRead | Response>): Promise<PolicyUpgradeRow | undefined> {
    if (await sourceCredentialGrant(deps, member.principalId, member.tenantId, record, "read")) return undefined;
    const row = { repo: record.name, source: sourceOf(record) };
    try {
      const state = (await cached(member.tenantId, record, maxAgeOf(member.tenantId, record))).status === "absent" ? "start" : "ok";
      const pull = listedPolicyPull(await listed(), record.name, row.source);
      return { ...row, upgrade: { state }, ...(pull && { pull }) };
    } catch (err) {
      deps.log({ level: "warn", msg: "policy_upgrade_read_failed", tenantId: member.tenantId, repo: record.name, error: errorText(err) });
      return { ...row, error: `Could not read ${record.name}'s policy from ${HOST_NAMES[row.source]}.` };
    }
  }

  /** Whether each enabled repository the member may read has a policy file (`ok`) or still needs one (`start`), and its open policy pull request. */
  async function upgradesRoute(member: Member): Promise<Response> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, member.tenantId), columns: { config: true } });
    const records = repoRecords(triageNs(tenant?.config)).filter((record) => record.connected && record.enabled);
    let listing: Promise<OpenPullsRead | Response> | undefined;
    function listed(): Promise<OpenPullsRead | Response> {
      listing ??= deps.openPulls(member, false);
      return listing;
    }
    const rows = await Promise.all(records.map((record) => upgradeOf(member, record, listed)));
    return Response.json({ repos: rows.filter((row) => row !== undefined) });
  }

  return { current, isNewest, onPush, fileRoute, exportRoute, patchRoute, pushAccessRoute, pushRoute, upgradesRoute };
}
