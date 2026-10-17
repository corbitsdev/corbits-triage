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
import { checkPackName, hasEnabledRules, legacyCheckPack, POLICY_FILE_PATH, repoPolicy, triageEventOf, WAITING_KIND, type RepoPolicy } from "@corbits/triage-contracts";
import { asRecord, errorText, isRecord } from "@corbits/common";
import { GITHUB_HOOK_HEADERS } from "@corbits/common/hook-metadata";
import { verifyXHubSignature } from "@corbits/common/x-hub-signature";
import { credentialAad, type CredentialCipher } from "@intx/types";
import type { DeliveryCache } from "./dedupe.js";
import { baseMoveOf, normalize, policyPushOf, type BaseMove, type PolicyPush } from "./normalize.js";
import type { PolicyFileSync } from "./policy-file.js";
import { readCappedBody } from "../read-json.js";
import {
  dropReposByInstallation,
  dropReposByName,
  patchCorbitsTriage,
  repoRecords,
  setConnectedForInstallation,
  sourceOf,
  triageNs,
  upsertConnectedRepos,
  type CorbitsTriageNs,
  type InstallationFields,
  type RepoRecord,
} from "./tenant-config.js";
import type { CheckPackRead, StoredPack } from "./check-pack-store.js";
import type { Accepted, Coalescer } from "./coalescer.js";
import type { OpenHeadReader } from "./tenant-open-heads.js";

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
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>;
  openHeadFor: (tenantId: string) => Promise<OpenHeadReader | undefined>;
  /** Has the repository's open pull requests but `except` triaged again, by its triage state key; resolves to how many were due. */
  recheckOpenPulls: (tenantId: string, key: string, except: number) => Promise<number>;
  /** Reads the repository's policy file into its policy; undefined when the repository is not connected. */
  syncPolicyFile: (tenantId: string, repo: string, removed: boolean) => Promise<PolicyFileSync | undefined>;
}

function repoRows(config: unknown): Array<Record<string, unknown>> {
  if (!config || typeof config !== "object") return [];
  const app = (config as Record<string, unknown>)["corbitsTriage"];
  if (!app || typeof app !== "object") return [];
  const repos = (app as Record<string, unknown>)["repos"];
  if (!Array.isArray(repos)) return [];
  return repos.flatMap((row) => (row && typeof row === "object" ? [row as Record<string, unknown>] : []));
}

function policyForRepo(config: unknown, repo: string): RepoPolicy {
  const row = repoRows(config).find((item) => item["name"] === repo);
  return repoPolicy(row);
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

async function appBotLogin(db: DB["db"], tenantId: string): Promise<string> {
  const { credential } = schema;
  const row = await db.query.credential.findFirst({ where: and(eq(credential.tenantId, tenantId), eq(credential.name, "github")) });
  const slug = asRecord(row?.metadata)?.["appSlug"];
  if (typeof slug !== "string" || slug === "") throw new Error("github app credential has no appSlug");
  return `${slug}[bot]`;
}

function isSentBy(payload: unknown, login: string): boolean {
  const sender = asRecord(asRecord(payload)?.["sender"]);
  return sender?.["type"] === "Bot" && sender["login"] === login;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
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
 * live deployment reads `pack`. `policy.source` names the policy artifact versions `pack` was resolved from, so the
 * run records what it used.
 */
export function mailPayload(record: Pick<RepoRecord, "name" | "source">, policy: RepoPolicy, { pack, automatic, source }: StoredPack, extra: Record<string, unknown>) {
  const repo = record.name;
  const repoSource = sourceOf(record);
  return {
    ...extra,
    kind: "pr",
    repo,
    // Absent on GitHub, so a deployment built before other hosts reads the mail unchanged.
    ...(repoSource !== "github" && { repoSource }),
    policy: { ...policy, checkPack: { name: checkPackName(repo) }, source },
    checkPack: legacyCheckPack(pack),
    pack,
    automatic,
  };
}

/** The mail for a head held for its CI: triage marks it waiting where it writes the verdict, and triages nothing. */
export function waitingPayload(record: Pick<RepoRecord, "name" | "source">, policy: RepoPolicy, pack: StoredPack, head: { number: number; headSha: string }) {
  return { ...mailPayload(record, policy, pack, { prNumber: head.number, headSha: head.headSha }), kind: WAITING_KIND };
}

export async function resolvedPack(
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>,
  tenantId: string,
  repo: string,
): Promise<StoredPack | null> {
  const read = await readCheckPack(tenantId, repo);
  return read.status === "ok" ? read : null;
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
    next = dropReposByName(next, gone.map((row) => row.name));
    next = upsertConnectedRepos(next, listing.names, listing.fields);
  }
  return next;
}

function applyInstallAction(
  event: string,
  action: string,
  payload: Record<string, unknown>,
  fields: InstallationFields,
  ns: CorbitsTriageNs,
): InstallPatch | undefined {
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
    return { ns: dropReposByName(ns, repoFullNames(payload["repositories_removed"])) };
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
    return json(202, { status: "ignored" });
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
    return json(500, { error: "tenant_config_unavailable" });
  }
  if (nextNs === undefined) {
    log({ level: "info", msg: "ignored", delivery, event, action, hook: loaded.credentialId, reason: "unconfigured_tenant" });
    return json(202, { status: "ignored" });
  }
  if (!applied) {
    log({ level: "info", msg: "ignored", delivery, event, action, hook: loaded.credentialId });
    return json(202, { status: "ignored" });
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

  log({ level: "info", msg: "accepted", delivery, event, action, hook: loaded.credentialId, reason: "recorded_only" });
  return json(202, { status: "accepted" });
}

export async function tenantConfigOf(d: Pick<BridgeDeps, "db">, tenantId: string): Promise<unknown> {
  return (await d.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } }))?.config;
}

/** A moved default branch can change every other open pull request's conflicts, so they are triaged again; the merged one is not. */
async function handleBaseMove(
  d: BridgeDeps,
  log: (entry: Record<string, unknown>) => void,
  loaded: BridgeHook,
  delivery: string,
  event: string,
  { repo, merged }: BaseMove,
): Promise<Response> {
  let tenantConfig: unknown;
  try {
    tenantConfig = await tenantConfigOf(d, loaded.tenantId);
  } catch {
    d.cache.forget(`${loaded.credentialId}:${delivery}`);
    return json(500, { error: "tenant_config_unavailable" });
  }
  const connected = repoRecords(triageNs(tenantConfig)).some((row) => row.name === repo && row.connected);
  if (!connected || !policyForRepo(tenantConfig, repo).enabled) {
    log({ level: "info", msg: "ignored", delivery, event, repo, hook: loaded.credentialId, reason: connected ? "repo_not_enabled" : "unconfigured_repo" });
    return json(202, { status: "ignored" });
  }
  let due: number;
  try {
    due = await d.recheckOpenPulls(loaded.tenantId, repo, merged);
  } catch (err) {
    d.cache.forget(`${loaded.credentialId}:${delivery}`);
    log({ level: "error", msg: "triage_state_unavailable", delivery, event, repo, error: String(err) });
    return json(500, { error: "triage_state_unavailable" });
  }
  log({ level: "info", msg: "base_moved", delivery, event, repo, merged, due, hook: loaded.credentialId });
  return json(202, { status: "accepted" });
}

/** A failed read is 500 so GitHub redelivers; a file that is not a valid policy is logged and leaves the policy as it was. */
async function handlePolicyPush(
  d: BridgeDeps,
  log: (entry: Record<string, unknown>) => void,
  loaded: BridgeHook,
  delivery: string,
  event: string,
  { repo, removed }: PolicyPush,
): Promise<Response> {
  let synced: PolicyFileSync | undefined;
  try {
    synced = await d.syncPolicyFile(loaded.tenantId, repo, removed);
  } catch (err) {
    d.cache.forget(`${loaded.credentialId}:${delivery}`);
    log({ level: "error", msg: "policy_file_sync_failed", delivery, event, repo, error: errorText(err) });
    return json(500, { error: "policy_file_sync_failed" });
  }
  if (!synced) {
    log({ level: "info", msg: "ignored", delivery, event, repo, hook: loaded.credentialId, reason: "unconfigured_repo" });
    return json(202, { status: "ignored" });
  }
  log({ level: "info", msg: "policy_file_pushed", delivery, event, repo, status: synced.status, hook: loaded.credentialId });
  return json(202, { status: "accepted" });
}

export function logJson(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

export function createBridgeHandler(d: BridgeDeps) {
  const log = d.log ?? logJson;
  return async function handleBridgeRequest(req: Request, target: { hookId: string; tenantHint?: string }): Promise<Response> {
    if (req.method !== "POST") return json(404, { error: "not_found" });
    let loaded: BridgeHook | undefined;
    try {
      loaded = await loadBridgeHook(d.db, d.cipher, target.hookId, target.tenantHint);
    } catch {
      return json(500, { error: "vault_error" });
    }
    // Do not leak name collisions or tenant misses, mirroring stock.
    if (!loaded) return json(404, { error: "unknown_hook" });

    const body = await readCappedBody(req);
    if (body === null) {
      log({ level: "warn", msg: "payload_too_large", hook: loaded.credentialId });
      return json(413, { error: "payload_too_large" });
    }
    const delivery = req.headers.get(GITHUB_HOOK_HEADERS.delivery);
    const event = req.headers.get(GITHUB_HOOK_HEADERS.event);
    if (!verifyXHubSignature(loaded.secret, req.headers.get(GITHUB_HOOK_HEADERS.signature), body)) {
      log({ level: "warn", msg: "bad_signature", delivery, hook: loaded.credentialId });
      return json(401, { error: "invalid_signature" });
    }
    if (!delivery || !event) return json(400, { error: "missing_headers" });
    if (d.cache.check(`${loaded.credentialId}:${delivery}`)) {
      log({ level: "info", msg: "duplicate", delivery, event, hook: loaded.credentialId });
      return json(200, { status: "duplicate" });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      d.cache.forget(`${loaded.credentialId}:${delivery}`);
      return json(400, { error: "invalid_json" });
    }
    if (INSTALL_EVENTS.has(event) && isRecord(payload)) {
      return handleInstallEvent(d, log, loaded, delivery, event, payload);
    }
    const pushed = policyPushOf(event, payload as Record<string, unknown>, POLICY_FILE_PATH);
    if (pushed) return handlePolicyPush(d, log, loaded, delivery, event, pushed);
    const moved = baseMoveOf(event, payload as Record<string, unknown>);
    if (moved) return handleBaseMove(d, log, loaded, delivery, event, moved);
    const mail = normalize(event, delivery, payload as Record<string, unknown>);
    if (!mail || mail.prNumber === null) {
      log({ level: "info", msg: "ignored", delivery, event, hook: loaded.credentialId });
      return json(202, { status: "ignored" });
    }
    const triageEvent = triageEventOf(mail);
    if (triageEvent === null) {
      log({ level: "info", msg: "ignored", delivery, event, action: mail.action, repo: mail.repo, hook: loaded.credentialId, reason: "no_triage_event" });
      return json(202, { status: "ignored" });
    }
    let botLogin: string;
    try {
      botLogin = await appBotLogin(d.db, loaded.tenantId);
    } catch (err) {
      d.cache.forget(`${loaded.credentialId}:${delivery}`);
      log({ level: "error", msg: "app_slug_unavailable", delivery, event, hook: loaded.credentialId, error: String(err) });
      return json(500, { error: "app_slug_unavailable" });
    }
    if (isSentBy(payload, botLogin)) {
      log({ level: "info", msg: "ignored", delivery, event, action: mail.action, repo: mail.repo, hook: loaded.credentialId, reason: "own_event" });
      return json(202, { status: "ignored" });
    }
    let tenantConfig: unknown;
    try {
      tenantConfig = await tenantConfigOf(d, loaded.tenantId);
    } catch {
      d.cache.forget(`${loaded.credentialId}:${delivery}`);
      return json(500, { error: "tenant_config_unavailable" });
    }
    const record = repoRecords(triageNs(tenantConfig)).find((row) => row.name === mail.repo && row.connected);
    if (!record) {
      log({ level: "info", msg: "ignored", delivery, event, repo: mail.repo, hook: loaded.credentialId, reason: "unconfigured_repo" });
      return json(202, { status: "ignored" });
    }
    const policy = policyForRepo(tenantConfig, mail.repo);
    if (!policy.enabled) {
      log({ level: "info", msg: "ignored", delivery, event, repo: mail.repo, hook: loaded.credentialId, reason: "repo_not_enabled" });
      return json(202, { status: "ignored" });
    }
    let head: Awaited<ReturnType<OpenHeadReader>>;
    if (mail.headSha === null || mail.draft === null) {
      try {
        head = await openHead(d, loaded.tenantId, record, mail.prNumber);
      } catch (err) {
        d.cache.forget(`${loaded.credentialId}:${delivery}`);
        log({ level: "error", msg: "head_lookup_failed", delivery, event, repo: mail.repo, pr: mail.prNumber, error: String(err) });
        return json(500, { error: "head_lookup_failed" });
      }
    }
    // A pull request no longer open is not a draft to skip; the workflow sees it closed.
    // Its conversion to draft is triaged once, so the verdict stops offering it as ready.
    if (mail.action !== "converted_to_draft" && (mail.draft ?? head?.draft ?? false)) {
      log({ level: "info", msg: "ignored", delivery, event, repo: mail.repo, pr: mail.prNumber, hook: loaded.credentialId, reason: "draft" });
      return json(202, { status: "ignored" });
    }
    const headSha = mail.headSha ?? head?.headSha;
    if (headSha === undefined) {
      log({ level: "info", msg: "ignored", delivery, event, repo: mail.repo, pr: mail.prNumber, hook: loaded.credentialId, reason: "not_open" });
      return json(202, { status: "ignored" });
    }
    const stored = await resolvedPack(d.readCheckPack, loaded.tenantId, mail.repo);
    if (!stored) {
      log({ level: "info", msg: "needs_setup", delivery, event, repo: mail.repo, hook: loaded.credentialId });
      return json(202, { status: "needs-setup" });
    }
    if (!hasEnabledRules(stored.pack)) {
      log({ level: "info", msg: "triage_skipped_no_rules", delivery, event, repo: mail.repo, pr: mail.prNumber, headSha, hook: loaded.credentialId });
      return json(202, { status: "ignored" });
    }
    let accepted: Accepted;
    try {
      accepted = await d.coalescer.accept({ tenantId: loaded.tenantId, workflow: loaded.workflow, record, policy, pack: stored.pack, automatic: stored.automatic, source: stored.source, mail, number: mail.prNumber, headSha, event: triageEvent });
    } catch (err) {
      d.cache.forget(`${loaded.credentialId}:${delivery}`);
      log({ level: "error", msg: "triage_state_unavailable", delivery, event, repo: mail.repo, pr: mail.prNumber, error: String(err) });
      return json(500, { error: "triage_state_unavailable" });
    }
    log({ level: "info", msg: accepted, delivery, event, action: mail.action, repo: mail.repo, pr: mail.prNumber, headSha, workflow: loaded.workflow });
    return json(202, { status: accepted });
  };
}
