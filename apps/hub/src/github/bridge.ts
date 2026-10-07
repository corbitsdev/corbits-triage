// Legacy GitHub bridge under /api/hooks. The stock @corbits/webhooks routes
// reject GitHub's X-Hub-Signature-256 HMAC with 401, so requests carrying that
// header are verified here against the app-level hook credential
// (metadata.webhook) and delivered through the stock run-trigger deliverer as
// the tenant system sender, so the run executes under its own materialized
// grants. No live or routable deployment maps to 503 so GitHub retries; any
// other delivery failure is 502.
//
// TODO (upstream github verifier): delete this bridge once @corbits/webhooks
// ships an X-Hub-Signature-256 verifier (with X-GitHub-Delivery replay keyed
// per credential). The hook URL stays the same; GitHub traffic then flows
// through the stock deliverer and this file goes away.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { checkPackName, repoPolicy, type CheckPack, type RepoPolicy } from "@corbits/triage-contracts";
import { credentialAad, type CredentialCipher } from "@intx/types";
import type { DeliveryCache } from "./dedupe.js";
import { isRunTriggerUnroutable } from "@corbits/webhooks";
import { NoLiveDeploymentError } from "./deployment.js";
import { normalize } from "./normalize.js";
import { verifySignature } from "./signature.js";
import {
  dropReposByInstallation,
  dropReposByName,
  markBacklogMailed,
  markBacklogPending,
  namesNeedingBacklog,
  patchCorbitsTriage,
  owesBacklog,
  repoRecords,
  setConnectedForInstallation,
  upsertConnectedRepos,
  type CorbitsTriageNs,
  type InstallationFields,
} from "./tenant-config.js";
import type { CheckPackRead } from "./check-pack-store.js";

const HOOK_VERIFY = ["bearer", "standard-webhooks", "slack"] as const;

/** Largest request body accepted, checked before anything is hashed (mirrors stock MAX_BODY_BYTES). */
export const MAX_BODY_BYTES = 1024 * 1024;

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
  sendMail: (tenantId: string, workflow: string, payload: unknown) => Promise<unknown>;
  log?: (entry: Record<string, unknown>) => void;
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>;
}

function isConnectedRepoRow(row: Record<string, unknown>): boolean {
  return typeof row["name"] === "string" && row["connected"] === true;
}

function configuredRepos(config: unknown): Set<unknown> {
  return new Set(repoRows(config).filter(isConnectedRepoRow).map((row) => row["name"]));
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

/** Null when the body exceeds MAX_BODY_BYTES, so the caller can answer 413 like the stock bodyLimit handler. */
async function readCappedBody(req: Request): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return null;
  }
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
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

const BACKLOG_WORKFLOW = "pr-triage-historical";
const INSTALL_EVENTS = new Set(["installation", "installation_repositories"]);
const REPO_LIST_CAP = 50;

function mailPayload(kind: "pr" | "backlog", repo: string, policy: RepoPolicy, pack: CheckPack, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    kind,
    repo,
    policy: { ...policy, checkPack: { name: checkPackName(repo) } },
    checkPack: pack,
  };
}

async function resolvedPack(
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>,
  tenantId: string,
  repo: string,
): Promise<CheckPack | null> {
  const read = await readCheckPack(tenantId, repo);
  return read.status === "ok" ? read.pack : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

function catchupNames(before: CorbitsTriageNs, listed: readonly string[], added: readonly string[]): string[] {
  const addedSet = new Set(added);
  return listed.filter((name) => addedSet.has(name) || owesBacklog(before, name, Date.now()));
}

function applyCreatedOrAdded(ns: CorbitsTriageNs, listed: { names: string[]; truncated: boolean }, fields: InstallationFields): InstallPatch {
  const upserted = upsertConnectedRepos(ns, listed.names, fields);
  return {
    ns: markBacklogPending(upserted.ns, catchupNames(ns, listed.names, upserted.added)),
    truncated: listed.truncated,
  };
}

/** A suspended installation keeps its repositories, disconnected; GitHub will not list them. */
export type InstallationListing =
  | { fields: InstallationFields; suspended: false; names: string[] }
  | { fields: InstallationFields; suspended: true };

/** Makes the stored repositories match what GitHub reports; returns the repositories that are new. */
export function applyInstallationListing(
  ns: CorbitsTriageNs,
  listings: readonly InstallationListing[],
): { ns: CorbitsTriageNs; added: string[] } {
  const live = new Set(listings.map((listing) => listing.fields.installationId));
  let next = ns;
  for (const row of repoRecords(ns)) {
    if (row.installationId !== undefined && !live.has(row.installationId)) next = dropReposByInstallation(next, row.installationId);
  }
  const added: string[] = [];
  for (const listing of listings) {
    const { installationId } = listing.fields;
    if (listing.suspended) {
      next = setConnectedForInstallation(next, installationId, false);
      continue;
    }
    const listed = new Set(listing.names);
    const gone = repoRecords(next).filter((row) => row.installationId === installationId && !listed.has(row.name));
    next = dropReposByName(next, gone.map((row) => row.name));
    const upserted = upsertConnectedRepos(next, listing.names, listing.fields);
    next = upserted.ns;
    added.push(...upserted.added);
  }
  return { ns: markBacklogPending(next, added), added };
}

export type BacklogDeps = Pick<BridgeDeps, "sendMail" | "readCheckPack"> & Pick<BridgeDeps, "db">;

/** Mails backlog catch-up for each repository that owes one and has a check pack; returns the repositories mailed. */
export async function sendBacklog(d: BacklogDeps, tenantId: string, ns: CorbitsTriageNs, names: readonly string[]): Promise<string[]> {
  const mailed: string[] = [];
  for (const repo of namesNeedingBacklog(ns, names, Date.now())) {
    const pack = await resolvedPack(d.readCheckPack, tenantId, repo);
    if (!pack) continue;
    const row = repoRecords(ns).find((item) => item.name === repo);
    await d.sendMail(tenantId, BACKLOG_WORKFLOW, mailPayload("backlog", repo, repoPolicy(row), pack));
    mailed.push(repo);
    await patchCorbitsTriage(d.db, tenantId, (current) => markBacklogMailed(current, [repo], Date.now()));
  }
  return mailed;
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

function payloadCatchupNames(event: string, action: string, payload: Record<string, unknown>): string[] {
  if (event === "installation" && action === "created") return repoFullNames(payload["repositories"]);
  if (event === "installation_repositories" && action === "added") return repoFullNames(payload["repositories_added"]);
  return [];
}

function mailFailure(err: unknown): Response {
  const stale = err instanceof NoLiveDeploymentError || isRunTriggerUnroutable(err);
  return json(stale ? 503 : 502, { error: stale ? "stale_deployment" : "hub_unavailable" });
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

  let mailed: string[] = [];
  try {
    mailed = await sendBacklog(d, loaded.tenantId, nextNs, payloadCatchupNames(event, action, payload));
  } catch (err) {
    d.cache.forget(`${loaded.credentialId}:${delivery}`);
    log({ level: "error", msg: "forward_failed", delivery, event, action, error: String(err) });
    return mailFailure(err);
  }
  log({
    level: "info",
    msg: mailed.length > 0 ? "forwarded" : "accepted",
    delivery,
    event,
    action,
    added: mailed,
    workflow: BACKLOG_WORKFLOW,
    hook: loaded.credentialId,
  });
  return json(202, { status: mailed.length > 0 ? "forwarded" : "accepted" });
}

function logJson(entry: Record<string, unknown>): void {
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
    const delivery = req.headers.get("x-github-delivery");
    const event = req.headers.get("x-github-event");
    if (!verifySignature(loaded.secret, body, req.headers.get("x-hub-signature-256"))) {
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
    if (INSTALL_EVENTS.has(event) && payload && typeof payload === "object" && !Array.isArray(payload)) {
      return handleInstallEvent(d, log, loaded, delivery, event, payload as Record<string, unknown>);
    }
    const mail = normalize(event, delivery, payload as Record<string, unknown>);
    if (!mail || mail.prNumber === null) {
      log({ level: "info", msg: "ignored", delivery, event, hook: loaded.credentialId });
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
      tenantConfig = (await d.db.query.tenant.findFirst({
        where: eq(schema.tenant.id, loaded.tenantId),
        columns: { config: true },
      }))?.config;
    } catch {
      d.cache.forget(`${loaded.credentialId}:${delivery}`);
      return json(500, { error: "tenant_config_unavailable" });
    }
    if (!configuredRepos(tenantConfig).has(mail.repo)) {
      log({ level: "info", msg: "ignored_unconfigured_repo", delivery, event, repo: mail.repo, hook: loaded.credentialId });
      return json(202, { status: "ignored" });
    }
    const policy = policyForRepo(tenantConfig, mail.repo);
    if (!policy.classificationAuthorized) {
      log({ level: "info", msg: "paused", delivery, event, repo: mail.repo, hook: loaded.credentialId });
      return json(202, { status: "paused" });
    }
    const pack = await resolvedPack(d.readCheckPack, loaded.tenantId, mail.repo);
    if (!pack) {
      log({ level: "info", msg: "needs_setup", delivery, event, repo: mail.repo, hook: loaded.credentialId });
      return json(202, { status: "needs-setup" });
    }
    try {
      await d.sendMail(
        loaded.tenantId,
        loaded.workflow,
        mailPayload("pr", mail.repo, policy, pack, mail as unknown as Record<string, unknown>),
      );
    } catch (err) {
      d.cache.forget(`${loaded.credentialId}:${delivery}`);
      log({ level: "error", msg: "forward_failed", delivery, event, repo: mail.repo, error: String(err) });
      return mailFailure(err);
    }
    log({ level: "info", msg: "forwarded", delivery, event, action: mail.action, repo: mail.repo, pr: mail.prNumber, workflow: loaded.workflow });
    return json(202, { status: "forwarded" });
  };
}
