import { logJson } from "../observability.js";
// Legacy GitHub bridge under /api/hooks. The stock @corbits/webhooks routes
// reject GitHub's X-Hub-Signature-256 HMAC with 401, so requests carrying that
// header are verified here against the app-level hook credential
// (metadata.webhook) and delivered through the stock run-trigger deliverer as
// the tenant system sender, so the run executes under its own materialized
// grants. Pull request events are marked queued and handed to the coalescer,
// which mails one run per pull request after a short window; a failed queue
// write is 500 so GitHub retries. A pull request merged into the default
// branch marks the repository's other heads outdated for the reconciler.
//
// TODO (upstream github verifier): delete this bridge once the hub runs
// @corbits/webhooks 0.4, whose x-hub-signature verifier this one shares
// (@corbits/common/x-hub-signature). The hook URL stays the same; GitHub
// traffic then flows through the stock deliverer and this file goes away.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { checkPackName, hasEnabledRules, legacyCheckPack, POLICY_FILE_PATHS, repoPolicy, triageEventOf, type ActionKind, type RepoPolicy, type RepoSource } from "@corbits/triage-contracts";
import { asRecord, errorText, isRecord } from "@corbits/common";
import { GITHUB_HOOK_HEADERS } from "@corbits/common/hook-metadata";
import { verifyXHubSignature } from "@corbits/common/x-hub-signature";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { GITHUB_CREDENTIAL, githubAppLogin } from "./app-key.js";
import type { DeliveryCache } from "./dedupe.js";
import { heldCredential } from "./portal-credential.js";
import { baseMoveOf, normalize, policyPushOf, type BaseMove, type GithubPolicyPush } from "./normalize.js";
import type { BacklogStart } from "./backlog-triage.js";
import type { PolicyFileState } from "./policy-file.js";
import { workflowPart } from "./pr-workflow.js";
import { readCappedBody } from "../read-json.js";
import {
  dropReposByInstallation,
  dropGithubReposByName,
  patchCorbitsTriage,
  repoRecords,
  setConnectedForInstallation,
  sourceOf,
  triageNs,
  triageStateKey,
  upsertConnectedRepos,
  type CorbitsTriageNs,
  type InstallationFields,
  type RepoRecord,
} from "./tenant-config.js";
import type { PolicyReader, ResolvedPack } from "./repo-policy.js";
import type { Accepted, Coalescer } from "./coalescer.js";
import type { OpenHeadReader } from "./tenant-open-heads.js";
import type { RepoReads } from "./repo-reads.js";

const HOOK_VERIFY = ["bearer", "standard-webhooks", "slack", "x-hub-signature"] as const;

export interface BridgeHook {
  credentialId: string;
  credentialName: string;
  tenantId: string;
  secret: string;
  workflow: string;
}

interface WebhookMeta {
  verify: string;
  to?: string;
  workflow?: string;
}

export interface BridgeDeps {
  db: DB["db"];
  cipher: CredentialCipher;
  cache: DeliveryCache;
  coalescer: Pick<Coalescer, "accept">;
  log?: (entry: Record<string, unknown>) => void;
  readCheckPack: PolicyReader;
  openHeadFor: (tenantId: string) => Promise<OpenHeadReader | undefined>;
  /** Has the repository's open pull requests but `except` triaged again, by its triage state key; resolves to how many were due. */
  recheckOpenPulls: (tenantId: string, key: string, except: number | null) => Promise<number>;
  /** Reads the repository's policy file again; undefined when the repository is not connected. */
  refreshPolicyFile: (tenantId: string, repo: string, source: RepoSource) => Promise<PolicyFileState | undefined>;
  startBacklog: BacklogStart;
  /** Told of each verified delivery naming a repository, so the reconciler lists that repository's pull requests again. */
  heard: (tenantId: string, source: RepoSource, repo: string) => void;
  /** Every verified delivery about a repository, so the GitHub reads kept for it are read again. */
  repoChanged: RepoReads["changed"];
  /** The workspace's GitHub repositories changed, so the read token, which names them, is minted again. */
  installationChanged: (tenantId: string) => void;
}

/** Mirrors @corbits/webhooks parseWebhookMeta (not exported upstream). */
function parseWebhookMeta(metadata: unknown): WebhookMeta | undefined {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const nested = (metadata as Record<string, unknown>)["webhook"];
  if (nested === null || typeof nested !== "object") return undefined;
  const hook = nested as Record<string, unknown>;
  const verify = hook["verify"];
  if (typeof verify !== "string" || !(HOOK_VERIFY as readonly string[]).includes(verify)) return undefined;
  const to = typeof hook["to"] === "string" ? hook["to"].trim() : "";
  const workflow = typeof hook["workflow"] === "string" ? hook["workflow"].trim() : "";
  return {
    verify,
    ...(to !== "" ? { to } : {}),
    ...(workflow !== "" ? { workflow } : {}),
  };
}

/** metadata.webhook `to` wins over `workflow`. */
function workflowOf(meta: WebhookMeta): string | undefined {
  return meta.to ?? meta.workflow;
}

/**
 * Mirrors @corbits/webhooks loadWebhook: tenant-owned, active credentials
 * with metadata.webhook only. Hook lookup by credential id is global; name
 * lookup is tenant-scoped and needs the tenant hint from the URL.
 */
export async function loadBridgeHook(
  db: DB["db"],
  cipher: CredentialCipher,
  id: string,
  tenantHint: string | undefined,
): Promise<BridgeHook | undefined> {
  const { credential } = schema;
  // Not the stock resolvers: a hook URL names one exact credential, by id with no tenant, never an ancestor's.
  let row: Awaited<ReturnType<typeof db.query.credential.findFirst>>;
  if (id.startsWith("crd_")) {
    row = await db.query.credential.findFirst({ where: eq(credential.id, id) });
  } else if (tenantHint !== undefined && tenantHint !== "") {
    row = await db.query.credential.findFirst({ where: and(eq(credential.tenantId, tenantHint), eq(credential.name, id)) });
  }
  if (!row || row.status !== "active") return undefined;
  if (row.principalId !== null && row.principalId !== undefined) return undefined;
  if (tenantHint && row.tenantId !== tenantHint) return undefined;
  const meta = parseWebhookMeta(row.metadata);
  const workflow = meta && workflowOf(meta);
  if (!workflow) return undefined;
  const secret = await cipher.decrypt(row.secret, credentialAad(row.id, "secret"));
  return { credentialId: row.id, credentialName: row.name, tenantId: row.tenantId, secret, workflow };
}

/** The App's bot account, named by the `github` credential the workspace resolves to: its own or a parent's. */
async function appBotLogin(db: DB["db"], tenantId: string): Promise<string> {
  const github = await heldCredential(db, tenantId, GITHUB_CREDENTIAL);
  if (!github) throw new Error("github app credential is missing");
  return githubAppLogin(github);
}

/** A mail in a workspace with GitHub names the App's bot account, whose comments and reviews the workflow takes as triage's own. */
export async function withAppLogin(db: DB["db"], tenantId: string, payload: unknown): Promise<unknown> {
  if (!isRecord(payload) || payload["repoSource"] !== undefined) return payload;
  return { ...payload, appLogin: await appBotLogin(db, tenantId) };
}

function isSentBy(payload: unknown, login: string): boolean {
  const sender = asRecord(asRecord(payload)?.["sender"]);
  return sender?.["type"] === "Bot" && sender["login"] === login;
}

const INSTALL_EVENTS = new Set(["installation", "installation_repositories"]);
const REPO_LIST_CAP = 50;

async function openHead(d: BridgeDeps, tenantId: string, record: RepoRecord, number: number) {
  const read = await d.openHeadFor(tenantId);
  if (!read) throw new Error("no active github credential");
  return read(record, number);
}

/**
 * The deployment reads `pack`; one built before steps reads `checkPack` and never sees `pack`, so both go until every
 * live deployment reads `pack`. `policy.source` names the policy file versions `pack` was resolved from, so the
 * run records what it used.
 */
export function mailPayload(record: Pick<RepoRecord, "name" | "source">, policy: RepoPolicy, { pack, automatic, source, policyWorkflow, pauseLabel }: ResolvedPack, extra: Record<string, unknown>) {
  const repo = record.name;
  const repoSource = sourceOf(record);
  return {
    ...extra,
    kind: "pr",
    repo,
    // Absent on GitHub, so a deployment built before other hosts reads the mail unchanged.
    ...(repoSource !== "github" && { repoSource }),
    policy: { ...policy, checkPack: { name: checkPackName(repo, repoSource) }, source },
    checkPack: legacyCheckPack(pack),
    pack,
    automatic,
    ...workflowPart(policyWorkflow),
    ...(pauseLabel && { pauseLabel }),
  };
}

/** A policy triage can't read is mailed in place of a pack, so the run marks the head failed instead of nothing happening. */
export type PolicyUnreadable = { policyUnreadable: string; automatic: ActionKind[] };

/** What the coalescer is handed for a read policy: its pack, or why it can't be read. Undefined when there is no policy. */
export async function triagePolicy(readCheckPack: PolicyReader, tenantId: string, repo: string, source: RepoSource): Promise<ResolvedPack | PolicyUnreadable | undefined> {
  const read = await readCheckPack(tenantId, repo, source);
  if (read.status === "missing") return undefined;
  if (read.status !== "ok") return { policyUnreadable: read.reason, automatic: read.automatic };
  const { status: _status, ...stored } = read;
  return stored;
}

/** A push that leaves the policy unreadable has every open head marked again, since none of them would be otherwise. */
async function recheckIfUnreadable(d: Pick<BridgeDeps, "readCheckPack" | "recheckOpenPulls">, tenantId: string, record: RepoRecord): Promise<void> {
  const read = await d.readCheckPack(tenantId, record.name, sourceOf(record));
  if (read.status === "invalid") await d.recheckOpenPulls(tenantId, triageStateKey(record), null);
}

export function unreadablePayload(record: Pick<RepoRecord, "name" | "source">, policy: RepoPolicy, { policyUnreadable, automatic }: PolicyUnreadable, extra: Record<string, unknown>) {
  const repoSource = sourceOf(record);
  return { ...extra, kind: "pr", repo: record.name, ...(repoSource !== "github" && { repoSource }), policy, policyUnreadable, automatic };
}

function installationFields(payload: Record<string, unknown>): InstallationFields | undefined {
  const inst = asRecord(payload["installation"]);
  if (!inst) return undefined;
  const id = inst["id"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return undefined;
  const account = asRecord(inst["account"])?.["login"];
  const htmlUrl = inst["html_url"];
  const selection = inst["repository_selection"] ?? payload["repository_selection"];
  return {
    installationId: id,
    ...(typeof account === "string" && account.length > 0 ? { account } : {}),
    ...(typeof htmlUrl === "string" && htmlUrl.length > 0 ? { installationUrl: htmlUrl } : {}),
    ...(selection === "all" || selection === "selected" ? { selection } : {}),
  };
}

function repoFullNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const row of list) {
    if (typeof row === "string" && row.length > 0) {
      names.push(row);
      continue;
    }
    const full = asRecord(row)?.["full_name"];
    if (typeof full === "string" && full.length > 0) names.push(full);
  }
  return names;
}

function listedRepos(list: unknown, truncatedFlag: unknown): { names: string[]; truncated: boolean } {
  const names = repoFullNames(list);
  return { names, truncated: truncatedFlag === true || names.length >= REPO_LIST_CAP };
}

type InstallPatch = { ns: CorbitsTriageNs; truncated?: boolean };

function applyCreatedOrAdded(ns: CorbitsTriageNs, listed: { names: string[]; truncated: boolean }, fields: InstallationFields): InstallPatch {
  return { ns: upsertConnectedRepos(ns, listed.names, fields), truncated: listed.truncated };
}

/** A suspended installation keeps its repositories, disconnected; GitHub will not list them. */
export type InstallationListing =
  | { fields: InstallationFields; suspended: false; names: string[] }
  | { fields: InstallationFields; suspended: true };

export function applyInstallationListing(ns: CorbitsTriageNs, listings: readonly InstallationListing[]): CorbitsTriageNs {
  const live = new Set(listings.map((listing) => listing.fields.installationId));
  let next = ns;
  for (const row of repoRecords(ns)) {
    if (row.installationId !== undefined && !live.has(row.installationId)) next = dropReposByInstallation(next, row.installationId);
  }
  for (const listing of listings) {
    const { installationId } = listing.fields;
    if (listing.suspended) {
      next = setConnectedForInstallation(next, installationId, false);
      continue;
    }
    const listed = new Set(listing.names);
    const gone = repoRecords(next).filter((row) => row.installationId === installationId && !listed.has(row.name));
    next = dropGithubReposByName(next, gone.map((row) => row.name));
    next = upsertConnectedRepos(next, listing.names, listing.fields);
  }
  return next;
}

/** One installation token serves the workspace, so another account's repositories are not added. */
function fromAnotherInstallation(ns: CorbitsTriageNs, installationId: number): boolean {
  return repoRecords(ns).some((record) => sourceOf(record) === "github" && record.installationId !== undefined && record.installationId !== installationId);
}

function applyInstallAction(
  event: string,
  action: string,
  payload: Record<string, unknown>,
  fields: InstallationFields,
  ns: CorbitsTriageNs,
): InstallPatch | undefined {
  if ((action === "created" || action === "added") && fromAnotherInstallation(ns, fields.installationId)) return undefined;
  if (event === "installation" && action === "created") {
    return applyCreatedOrAdded(ns, listedRepos(payload["repositories"], payload["repositories_truncated"]), fields);
  }
  if (event === "installation_repositories" && action === "added") {
    return applyCreatedOrAdded(
      ns,
      listedRepos(payload["repositories_added"], payload["repositories_added_truncated"] ?? payload["repositories_truncated"]),
      fields,
    );
  }
  if (event === "installation_repositories" && action === "removed") {
    return { ns: dropGithubReposByName(ns, repoFullNames(payload["repositories_removed"])) };
  }
  if (event === "installation" && action === "deleted") {
    return { ns: dropReposByInstallation(ns, fields.installationId) };
  }
  if (event === "installation" && action === "suspend") {
    return { ns: setConnectedForInstallation(ns, fields.installationId, false) };
  }
  if (event === "installation" && action === "unsuspend") {
    return { ns: setConnectedForInstallation(ns, fields.installationId, true) };
  }
  return undefined;
}

async function handleInstallEvent(
  d: BridgeDeps,
  log: (entry: Record<string, unknown>) => void,
  loaded: BridgeHook,
  delivery: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const action = payload["action"];
  const fields = installationFields(payload);
  if (typeof action !== "string" || !fields || action === "new_permissions_accepted") {
    log({ level: "info", msg: "ignored", delivery, event, hook: loaded.credentialId });
    return Response.json({ status: "ignored" }, { status: 202 });
  }

  let truncated = false;
  let applied = false;
  const apply = function apply(ns: CorbitsTriageNs): CorbitsTriageNs {
    const result = applyInstallAction(event, action, payload, fields, ns);
    if (!result) return ns;
    applied = true;
    truncated = result.truncated === true;
    return result.ns;
  };
  let nextNs: CorbitsTriageNs | undefined;
  try {
    nextNs = await patchCorbitsTriage(d.db, loaded.tenantId, apply);
  } catch {
    d.cache.forget(`${loaded.credentialId}:${delivery}`);
    return Response.json({ error: "tenant_config_unavailable" }, { status: 500 });
  }
  if (nextNs === undefined) {
    log({ level: "info", msg: "ignored", delivery, event, action, hook: loaded.credentialId, reason: "unconfigured_tenant" });
    return Response.json({ status: "ignored" }, { status: 202 });
  }
  if (!applied) {
    log({ level: "info", msg: "ignored", delivery, event, action, hook: loaded.credentialId });
    return Response.json({ status: "ignored" }, { status: 202 });
  }
  if (truncated) {
    log({
      level: "warn",
      msg: "installation_repositories_truncated",
      delivery,
      event,
      action,
      installationId: fields.installationId,
      hook: loaded.credentialId,
    });
  }

  d.installationChanged(loaded.tenantId);
  log({ level: "info", msg: "accepted", delivery, event, action, hook: loaded.credentialId, reason: "recorded_only" });
  return Response.json({ status: "accepted" }, { status: 202 });
}

export async function tenantConfigOf(d: Pick<BridgeDeps, "db">, tenantId: string): Promise<unknown> {
  return (await d.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } }))?.config;
}

/** The connected GitHub record of `repo`, or the response to return; another host's repository of the same name is not this one. */
async function connectedRecord(
  d: BridgeDeps,
  log: (entry: Record<string, unknown>) => void,
  loaded: BridgeHook,
  delivery: string,
  event: string,
  repo: string,
): Promise<RepoRecord | Response> {
  let tenantConfig: unknown;
  try {
    tenantConfig = await tenantConfigOf(d, loaded.tenantId);
  } catch {
    d.cache.forget(`${loaded.credentialId}:${delivery}`);
    return Response.json({ error: "tenant_config_unavailable" }, { status: 500 });
  }
  const record = repoRecords(triageNs(tenantConfig)).find((row) => row.name === repo && sourceOf(row) === "github" && row.connected);
  if (record) return record;
  log({ level: "info", msg: "ignored", delivery, event, repo, hook: loaded.credentialId, reason: "unconfigured_repo" });
  return Response.json({ status: "ignored" }, { status: 202 });
}

/**
 * A moved default branch can change every other open pull request's conflicts, so they are triaged again; the merged one is
 * not. The merge may also have changed the policy file, and an App registered before it subscribed to `push` hears only this.
 */
async function handleBaseMove(
  d: BridgeDeps,
  log: (entry: Record<string, unknown>) => void,
  loaded: BridgeHook,
  delivery: string,
  event: string,
  { repo, merged }: BaseMove,
): Promise<Response> {
  const record = await connectedRecord(d, log, loaded, delivery, event, repo);
  if (record instanceof Response) return record;
  try {
    await d.refreshPolicyFile(loaded.tenantId, repo, "github");
  } catch (err) {
    d.cache.forget(`${loaded.credentialId}:${delivery}`);
    log({ level: "error", msg: "policy_file_read_failed", delivery, event, repo, error: errorText(err) });
    return Response.json({ error: "policy_file_read_failed" }, { status: 500 });
  }
  if (!repoPolicy(record).enabled) {
    log({ level: "info", msg: "ignored", delivery, event, repo, hook: loaded.credentialId, reason: "repo_not_enabled" });
    return Response.json({ status: "ignored" }, { status: 202 });
  }
  let due: number;
  try {
    due = await d.recheckOpenPulls(loaded.tenantId, repo, merged);
  } catch (err) {
    d.cache.forget(`${loaded.credentialId}:${delivery}`);
    log({ level: "error", msg: "triage_state_unavailable", delivery, event, repo, error: String(err) });
    return Response.json({ error: "triage_state_unavailable" }, { status: 500 });
  }
  log({ level: "info", msg: "base_moved", delivery, event, repo, merged, due, hook: loaded.credentialId });
  return Response.json({ status: "accepted" }, { status: 202 });
}

/**
 * A failed read is 500 so GitHub redelivers; until a read succeeds, the next trigger reads the file itself. A push that
 * changed the file has the open pull requests triaged, as turning triage on does, wherever triage would run.
 */
async function handlePolicyPush(
  d: BridgeDeps,
  log: (entry: Record<string, unknown>) => void,
  loaded: BridgeHook,
  delivery: string,
  event: string,
  { repo, changed }: GithubPolicyPush,
): Promise<Response> {
  const record = await connectedRecord(d, log, loaded, delivery, event, repo);
  if (record instanceof Response) return record;
  let read: PolicyFileState | undefined;
  try {
    read = await d.refreshPolicyFile(loaded.tenantId, repo, "github");
    if (read) await recheckIfUnreadable(d, loaded.tenantId, record);
  } catch (err) {
    d.cache.forget(`${loaded.credentialId}:${delivery}`);
    log({ level: "error", msg: "policy_file_read_failed", delivery, event, repo, error: errorText(err) });
    return Response.json({ error: "policy_file_read_failed" }, { status: 500 });
  }
  if (!read) {
    log({ level: "info", msg: "ignored", delivery, event, repo, hook: loaded.credentialId, reason: "unconfigured_repo" });
    return Response.json({ status: "ignored" }, { status: 202 });
  }
  log({ level: "info", msg: "policy_file_pushed", delivery, event, repo, status: read.status, hook: loaded.credentialId });
  if (changed) {
    const started = await d.startBacklog(loaded.tenantId, record);
    log({ level: "info", msg: "policy_push_backlog", delivery, event, repo, status: started.status, hook: loaded.credentialId });
  }
  return Response.json({ status: "accepted" }, { status: 202 });
}

export { logJson } from "../observability.js";

export function createBridgeHandler(d: BridgeDeps) {
  const log = d.log ?? logJson;
  return async function handleBridgeRequest(req: Request, target: { hookId: string; tenantHint?: string }): Promise<Response> {
    if (req.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
    let loaded: BridgeHook | undefined;
    try {
      loaded = await loadBridgeHook(d.db, d.cipher, target.hookId, target.tenantHint);
    } catch {
      return Response.json({ error: "vault_error" }, { status: 500 });
    }
    // Do not leak name collisions or tenant misses, mirroring stock.
    if (!loaded) return Response.json({ error: "unknown_hook" }, { status: 404 });

    const body = await readCappedBody(req);
    if (body === null) {
      log({ level: "warn", msg: "payload_too_large", hook: loaded.credentialId });
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    const delivery = req.headers.get(GITHUB_HOOK_HEADERS.delivery);
    const event = req.headers.get(GITHUB_HOOK_HEADERS.event);
    if (!verifyXHubSignature(loaded.secret, req.headers.get(GITHUB_HOOK_HEADERS.signature), body)) {
      log({ level: "warn", msg: "bad_signature", delivery, hook: loaded.credentialId });
      return Response.json({ error: "invalid_signature" }, { status: 401 });
    }
    if (!delivery || !event) return Response.json({ error: "missing_headers" }, { status: 400 });
    if (d.cache.check(`${loaded.credentialId}:${delivery}`)) {
      log({ level: "info", msg: "duplicate", delivery, event, hook: loaded.credentialId });
      return Response.json({ status: "duplicate" }, { status: 200 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      d.cache.forget(`${loaded.credentialId}:${delivery}`);
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const named = asRecord(asRecord(payload)?.["repository"])?.["full_name"];
    if (typeof named === "string") {
      d.heard(loaded.tenantId, "github", named);
      d.repoChanged(loaded.tenantId, named, event);
    }
    if (INSTALL_EVENTS.has(event) && isRecord(payload)) {
      return handleInstallEvent(d, log, loaded, delivery, event, payload);
    }
    const pushed = policyPushOf(event, payload as Record<string, unknown>, POLICY_FILE_PATHS);
    if (pushed) return handlePolicyPush(d, log, loaded, delivery, event, pushed);
    const moved = baseMoveOf(event, payload as Record<string, unknown>);
    if (moved) return handleBaseMove(d, log, loaded, delivery, event, moved);
    const mail = normalize(event, delivery, payload as Record<string, unknown>);
    if (!mail || mail.prNumber === null) {
      log({ level: "info", msg: "ignored", delivery, event, hook: loaded.credentialId });
      return Response.json({ status: "ignored" }, { status: 202 });
    }
    const unlabeled = asRecord(asRecord(payload)?.["label"])?.["name"];
    const unpausing = event === "pull_request" && mail.action === "unlabeled" && typeof unlabeled === "string";
    const triageEvent = unpausing ? "updated" : triageEventOf(mail);
    if (triageEvent === null) {
      log({ level: "info", msg: "ignored", delivery, event, action: mail.action, repo: mail.repo, hook: loaded.credentialId, reason: "no_triage_event" });
      return Response.json({ status: "ignored" }, { status: 202 });
    }
    let botLogin: string;
    try {
      botLogin = await appBotLogin(d.db, loaded.tenantId);
    } catch (err) {
      d.cache.forget(`${loaded.credentialId}:${delivery}`);
      log({ level: "error", msg: "app_slug_unavailable", delivery, event, hook: loaded.credentialId, error: String(err) });
      return Response.json({ error: "app_slug_unavailable" }, { status: 500 });
    }
    if (isSentBy(payload, botLogin)) {
      log({ level: "info", msg: "ignored", delivery, event, action: mail.action, repo: mail.repo, hook: loaded.credentialId, reason: "own_event" });
      return Response.json({ status: "ignored" }, { status: 202 });
    }
    const record = await connectedRecord(d, log, loaded, delivery, event, mail.repo);
    if (record instanceof Response) return record;
    const policy = repoPolicy(record);
    if (!policy.enabled) {
      log({ level: "info", msg: "ignored", delivery, event, repo: mail.repo, hook: loaded.credentialId, reason: "repo_not_enabled" });
      return Response.json({ status: "ignored" }, { status: 202 });
    }
    // A check event names its head but not whether the pull request is a draft or open; its window reads that once at its flush.
    const draftUnread = mail.headSha !== null && mail.draft === null;
    let head: Awaited<ReturnType<OpenHeadReader>>;
    if (mail.headSha === null) {
      try {
        head = await openHead(d, loaded.tenantId, record, mail.prNumber);
      } catch (err) {
        d.cache.forget(`${loaded.credentialId}:${delivery}`);
        log({ level: "error", msg: "head_lookup_failed", delivery, event, repo: mail.repo, pr: mail.prNumber, error: String(err) });
        return Response.json({ error: "head_lookup_failed" }, { status: 500 });
      }
    }
    // A pull request no longer open is not a draft to skip; the workflow sees it closed.
    // Its conversion to draft is triaged once, so the verdict stops offering it as ready.
    if (mail.action !== "converted_to_draft" && (mail.draft ?? head?.draft ?? false)) {
      log({ level: "info", msg: "ignored", delivery, event, repo: mail.repo, pr: mail.prNumber, hook: loaded.credentialId, reason: "draft" });
      return Response.json({ status: "ignored" }, { status: 202 });
    }
    const headSha = mail.headSha ?? head?.headSha;
    if (headSha === undefined) {
      log({ level: "info", msg: "ignored", delivery, event, repo: mail.repo, pr: mail.prNumber, hook: loaded.credentialId, reason: "not_open" });
      return Response.json({ status: "ignored" }, { status: 202 });
    }
    let stored: Awaited<ReturnType<typeof triagePolicy>>;
    try {
      stored = await triagePolicy(d.readCheckPack, loaded.tenantId, mail.repo, "github");
    } catch (err) {
      d.cache.forget(`${loaded.credentialId}:${delivery}`);
      log({ level: "error", msg: "policy_read_failed", delivery, event, repo: mail.repo, error: errorText(err) });
      return Response.json({ error: "policy_read_failed" }, { status: 500 });
    }
    if (!stored) {
      log({ level: "info", msg: "needs_setup", delivery, event, repo: mail.repo, hook: loaded.credentialId });
      return Response.json({ status: "needs-setup" }, { status: 202 });
    }
    if (unpausing && ("policyUnreadable" in stored || unlabeled !== stored.pauseLabel)) {
      log({ level: "info", msg: "ignored", delivery, event, action: mail.action, repo: mail.repo, hook: loaded.credentialId, reason: "no_triage_event" });
      return Response.json({ status: "ignored" }, { status: 202 });
    }
    if ("pack" in stored && !hasEnabledRules(stored.pack)) {
      log({ level: "info", msg: "triage_skipped_no_rules", delivery, event, repo: mail.repo, pr: mail.prNumber, headSha, hook: loaded.credentialId });
      return Response.json({ status: "ignored" }, { status: 202 });
    }
    let accepted: Accepted;
    try {
      accepted = await d.coalescer.accept({ tenantId: loaded.tenantId, workflow: loaded.workflow, record, policy, ...stored, mail, number: mail.prNumber, headSha, event: triageEvent, ...(draftUnread && { draftUnread: true }) });
    } catch (err) {
      d.cache.forget(`${loaded.credentialId}:${delivery}`);
      log({ level: "error", msg: "triage_state_unavailable", delivery, event, repo: mail.repo, pr: mail.prNumber, error: String(err) });
      return Response.json({ error: "triage_state_unavailable" }, { status: 500 });
    }
    log({ level: "info", msg: accepted, delivery, event, action: mail.action, repo: mail.repo, pr: mail.prNumber, headSha, workflow: loaded.workflow });
    return Response.json({ status: accepted }, { status: 202 });
  };
}
