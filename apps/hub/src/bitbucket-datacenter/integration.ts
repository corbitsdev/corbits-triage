// A workspace's Bitbucket Data Center connection. Secrets are stock credentials written through the stock routes as the
// caller, so stock authz decides who may store them; the namespace holds only the instance URL.
import { randomBytes } from "node:crypto";
import { type } from "arktype";
import { BITBUCKET_DATACENTER_HOOK_HEADERS, xHubHookMetadata } from "@corbits/common/hook-metadata";
import type { BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import { TRIAGE_LISTENERS } from "@corbits/triage-contracts";
import { ensureDeployerRole } from "../deployer-role.js";
import { ensureTriageRole, grantEnabledKinds } from "../github/automation.js";
import { tenantConfigOf } from "../github/bridge.js";
import { activeCredential, credentialSecret, failure, holds, type PortalCredentialDeps } from "../github/portal-credential.js";
import { patchCorbitsTriage, repoRecords, triageNs, type CorbitsTriageNs, type RepoRecord } from "../github/tenant-config.js";
import type { Member } from "../integrations/app.js";
import { asCaller } from "../stock-caller.js";
import {
  BitbucketFailed, bitbucketFetch, createWebhook, defaultBranch, deleteWebhook, InstanceRepo, lookupAddresses, pagedValues, readRepo,
  resolveInstance, saveWebhook, WEBHOOK_EVENTS, webhookExists, type AddressLookup, type Instance,
} from "./client.js";
import { bitbucketConnection, bitbucketRepoName, disableRepo, disconnect, enableRepo, forgetWebhooks, HOOK_CREDENTIAL, isBitbucketRecord, listedRepos, PROVIDER, splitName, TOKEN_CREDENTIAL } from "./records.js";

export const BITBUCKET_PATH = "/api/integrations/bitbucket-datacenter";
const BITBUCKET_HOOK_PATH = "/api/hooks/bitbucket-datacenter";
const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const HOST_REFUSED = "The host must resolve only to public addresses; a private-network instance needs the hub operator to allowlist it.";
const HOOK_METADATA = xHubHookMetadata(TRIAGE_LISTENERS["bitbucket-datacenter"], BITBUCKET_DATACENTER_HOOK_HEADERS);

const NewConnection = type({ baseUrl: "string > 0", token: "string > 0" });
/** Connects, or replaces the token in place; `rotateHookSecret` instead signs the webhooks triage created with a new secret. */
export const ConnectBody = NewConnection.or({ rotateHookSecret: "true" });
export const Connection = type({ baseUrl: "string", hookUrl: "string" });
export const Connected = type({ baseUrl: "string", hookUrl: "string", hookSecretSet: "true" });
export const HookSecretRotated = type({ webhooksByHand: "string[]" });
export const Disconnected = type({ webhooksLeft: "string[]" });
const BitbucketRepo = type({ name: "string", connected: "boolean", source: "'bitbucket-datacenter'", "enabled?": "boolean", "defaultBranch?": "string", "webhookId?": "number" });
export const BitbucketRepos = type({ repositories: BitbucketRepo.array() });
export const RepoEnabled = type({
  repository: BitbucketRepo,
  webhook: "'created' | 'manual'",
  hookUrl: "string",
  "hookSecret?": "string",
  "events?": "string[]",
});
export const RepoDisabled = type({ repository: BitbucketRepo, webhookLeft: "boolean" });
export const RepoWebhook = type({ webhook: "'manual'", hookUrl: "string", hookSecret: "string", events: "string[]" })
  .or({ webhook: "'registered'", webhookId: "number" });

const ApplicationProperties = type({ version: "string", displayName: "string" });
const StockRow = type({ id: "string", name: "string", "status?": "string", "apiBaseUrl?": "string | null" });
const StockPage = type({ data: StockRow.array(), "nextCursor?": "string | null" });

type BitbucketDeps = PortalCredentialDeps & {
  stockFetch: (req: Request) => Promise<Response>;
  /** The hub's public origin; behind a TLS proxy the request URL is not. */
  publicOrigin: string;
  fetchImpl: typeof fetch;
  /** Resolves the instance host. Defaults to DNS. Tests inject it so nothing is looked up for real. */
  lookup?: AddressLookup;
  /** Hostnames or literal IPs the operator allows even when they are private or loopback. */
  egressAllowlist?: readonly string[];
  /** Called once a repository is enabled, so its open pull requests are triaged without waiting for the next pass. */
  onEnabled: (tenantId: string) => void;
  /** Called after connect and disconnect, so a disconnected host's listener and managers are released. */
  onConnectionChanged: (tenantId: string) => Promise<void>;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

function instanceFailed(err: unknown): Response {
  if (err instanceof BitbucketFailed) return failure(502, "bitbucket_datacenter_failed", err.message);
  if (err instanceof TypeError) return failure(502, "bitbucket_datacenter_unreachable", "The Bitbucket instance could not be reached.");
  throw err;
}

export function createBitbucketIntegration(deps: BitbucketDeps) {
  const { db } = deps;
  const lookup = deps.lookup ?? lookupAddresses;

  function reachable(value: string): Promise<Instance | undefined> {
    return resolveInstance(value, lookup, deps.egressAllowlist);
  }

  function hookUrl(tenantId: string): string {
    return `${deps.publicOrigin}${BITBUCKET_HOOK_PATH}/${encodeURIComponent(tenantId)}`;
  }

  async function manageRefusal(member: Member): Promise<Response | undefined> {
    if (await deps.authorize(member.principalId, member.tenantId, `tenant:${member.tenantId}`, "manage")) return undefined;
    return failure(403, "forbidden", "You do not have permission to manage this workspace.");
  }

  async function tenantNs(tenantId: string): Promise<CorbitsTriageNs> {
    return triageNs(await tenantConfigOf(deps, tenantId));
  }

  async function usableCredential(member: Member, name: string) {
    const credential = await activeCredential(db, member.tenantId, name);
    if (!credential) return failure(409, "bitbucket_datacenter_not_connected", "Connect Bitbucket first.");
    if (!(await holds(deps, member.principalId, member.tenantId, `credential:${credential.id}`, "use"))) {
      return failure(403, "forbidden", "You do not have access to the Bitbucket credential.");
    }
    return credential;
  }

  async function secretOf(member: Member, name: string): Promise<string | Response> {
    const credential = await usableCredential(member, name);
    return credential instanceof Response ? credential : credentialSecret(deps.cipher, credential);
  }

  async function instance(member: Member): Promise<BitbucketFetch | Response> {
    const credential = await usableCredential(member, TOKEN_CREDENTIAL);
    if (credential instanceof Response) return credential;
    const connection = bitbucketConnection(await tenantNs(credential.tenantId));
    if (!connection) return failure(409, "bitbucket_datacenter_not_connected", "Connect Bitbucket first.");
    const checked = await reachable(connection.baseUrl);
    if (checked === undefined) return failure(409, "bitbucket_datacenter_host_refused", HOST_REFUSED);
    return bitbucketFetch(deps.fetchImpl, checked, await credentialSecret(deps.cipher, credential));
  }

  function stock(req: Request, method: string, path: string, body?: unknown): Promise<Response> {
    return deps.stockFetch(asCaller(req, method, path, body));
  }

  async function stockRows(req: Request, path: string): Promise<Array<typeof StockRow.infer> | Response> {
    const rows: Array<typeof StockRow.infer> = [];
    let cursor: string | null | undefined;
    do {
      const res = await stock(req, "GET", `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!res.ok) return res;
      const page = StockPage.assert(await res.json());
      rows.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }

  async function ensureProvider(req: Request, tenantId: string, apiBaseUrl: string): Promise<string | Response> {
    const base = `/api/tenants/${encodeURIComponent(tenantId)}/providers`;
    const rows = await stockRows(req, `${base}?inherited=false&limit=100`);
    if (rows instanceof Response) return rows;
    const existing = rows.find((row) => row.name === PROVIDER);
    if (existing) {
      if (existing.apiBaseUrl === apiBaseUrl) return existing.id;
      const patched = await stock(req, "PATCH", `${base}/${encodeURIComponent(existing.id)}`, { plugin: "http", apiBaseUrl });
      return patched.ok ? existing.id : patched;
    }
    const created = await stock(req, "POST", base, { name: PROVIDER, plugin: "http", apiBaseUrl });
    if (!created.ok) return created;
    return StockRow.assert(await created.json()).id;
  }

  async function resolveCredential(req: Request, tenantId: string, name: string): Promise<typeof StockRow.infer | undefined | Response> {
    const res = await stock(req, "GET", `/api/tenants/${encodeURIComponent(tenantId)}/credentials/resolve/${encodeURIComponent(name)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) return res;
    return StockRow.assert(await res.json());
  }

  /** Writes the secret, unless `keep` and an active credential already holds one. */
  async function writeCredential(
    req: Request,
    tenantId: string,
    providerId: string,
    value: { name: string; secret: string; metadata?: Record<string, unknown>; keep?: boolean },
  ): Promise<Response | undefined> {
    const base = `/api/tenants/${encodeURIComponent(tenantId)}/credentials`;
    const existing = await resolveCredential(req, tenantId, value.name);
    if (existing instanceof Response) return existing;
    if (existing === undefined) {
      const created = await stock(req, "POST", base, { providerId, name: value.name, type: "api_key", secret: value.secret, ...(value.metadata && { metadata: value.metadata }) });
      return created.ok ? undefined : created;
    }
    if (value.keep && existing.status === "active") return undefined;
    const patched = await stock(req, "PATCH", `${base}/${encodeURIComponent(existing.id)}`, { secret: value.secret, status: "active", ...(value.metadata && { metadata: value.metadata }) });
    return patched.ok ? undefined : patched;
  }

  async function removeCredential(req: Request, tenantId: string, name: string): Promise<Response | undefined> {
    const existing = await resolveCredential(req, tenantId, name);
    if (existing === undefined || existing instanceof Response) return existing;
    const deleted = await stock(req, "DELETE", `/api/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(existing.id)}`);
    return deleted.ok || deleted.status === 404 ? undefined : deleted;
  }

  /** The token is tried once against the instance and stored only when the instance accepts it; resolves to the user it acts as. */
  async function verifyToken(checked: Instance, token: string): Promise<Response | string> {
    let res: Response;
    try {
      res = await bitbucketFetch(deps.fetchImpl, checked, token)("/rest/api/1.0/application-properties");
    } catch (err) {
      return instanceFailed(err);
    }
    if (res.status === 401) return failure(400, "bitbucket_datacenter_token_invalid", "The Bitbucket instance did not accept the token.");
    if (!res.ok) return failure(502, "bitbucket_datacenter_failed", `Bitbucket answered ${res.status}.`);
    let properties: unknown;
    try {
      properties = await res.json();
    } catch {
      properties = undefined;
    }
    if (!ApplicationProperties.allows(properties)) return failure(400, "not_bitbucket_datacenter", "That URL is not a Bitbucket Data Center instance.");
    // Bitbucket answers application properties anonymously too, and names the user only when the token signed in.
    const user = res.headers.get("x-ausername");
    if (!res.headers.has("x-auserid") || !user) return failure(400, "bitbucket_datacenter_token_invalid", "The Bitbucket instance did not accept the token.");
    return user;
  }

  /**
   * The new secret is stored, then each webhook triage created is saved again with it; deliveries refused in between are
   * caught up by the reconciler. A webhook that could not be saved is left to be set up by hand, so the repositories
   * named are those whose webhook someone updates on the instance.
   */
  async function rotateHookSecret(member: Member, req: Request): Promise<Response> {
    const connection = bitbucketConnection(await tenantNs(member.tenantId));
    if (!connection) return failure(409, "bitbucket_datacenter_not_connected", "Connect Bitbucket first.");
    const bb = await instance(member);
    if (bb instanceof Response) return bb;
    const secret = randomBytes(32).toString("hex");
    const providerId = await ensureProvider(req, member.tenantId, connection.baseUrl);
    if (providerId instanceof Response) return providerId;
    const hookFailed = await writeCredential(req, member.tenantId, providerId, { name: HOOK_CREDENTIAL, secret, metadata: HOOK_METADATA });
    if (hookFailed) return hookFailed;
    const url = hookUrl(member.tenantId);
    const webhooksByHand: string[] = [];
    const unsaved = new Set<string>();
    for (const record of repoRecords(await tenantNs(member.tenantId)).filter((row) => isBitbucketRecord(row) && row.enabled === true)) {
      if (record.webhookId !== undefined) {
        try {
          await saveWebhook(bb, ...splitName(record.name), record.webhookId, url, secret);
          continue;
        } catch (err) {
          deps.log({ level: "warn", msg: "bitbucket_datacenter_webhook_not_saved", tenantId: member.tenantId, repo: record.name, error: String(err) });
          unsaved.add(record.name);
        }
      }
      webhooksByHand.push(record.name);
    }
    if (unsaved.size > 0) {
      await patchCorbitsTriage(db, member.tenantId, function leaveToHand(ns) {
        return forgetWebhooks(ns, unsaved);
      });
    }
    return Response.json({ webhooksByHand });
  }

  async function connect(body: typeof ConnectBody.infer, member: Member, req: Request): Promise<Response> {
    const refused = await manageRefusal(member);
    if (refused) return refused;
    if ("rotateHookSecret" in body) return rotateHookSecret(member, req);
    const checked = await reachable(body.baseUrl);
    if (!checked) return failure(400, "invalid_request", `baseUrl must be an http(s) URL without credentials, query, or fragment. ${HOST_REFUSED}`);
    const { baseUrl } = checked;
    const ns = await tenantNs(member.tenantId);
    const current = bitbucketConnection(ns);
    if (current && current.baseUrl !== baseUrl && repoRecords(ns).some(isBitbucketRecord)) {
      return failure(409, "bitbucket_datacenter_connected_elsewhere", `This workspace is connected to ${current.baseUrl}. Disconnect it first.`);
    }
    const user = await verifyToken(checked, body.token);
    if (user instanceof Response) return user;
    const providerId = await ensureProvider(req, member.tenantId, baseUrl);
    if (providerId instanceof Response) return providerId;
    const tokenFailed = await writeCredential(req, member.tenantId, providerId, { name: TOKEN_CREDENTIAL, secret: body.token });
    if (tokenFailed) return tokenFailed;
    // An existing hook secret is kept: webhooks already on the instance sign with it.
    const hookFailed = await writeCredential(req, member.tenantId, providerId, {
      name: HOOK_CREDENTIAL, secret: randomBytes(32).toString("hex"), metadata: HOOK_METADATA, keep: true,
    });
    if (hookFailed) return hookFailed;
    const written = await patchCorbitsTriage(db, member.tenantId, async function setConnection(next, tx) {
      await ensureTriageRole(tx, member.tenantId, deps.now());
      await ensureDeployerRole(tx, member.tenantId, deps.now());
      return { ...next, bitbucketDatacenter: { baseUrl, user } };
    });
    if (!written) return failure(404, "not_found", "Workspace not found.");
    await deps.onConnectionChanged(member.tenantId);
    return Response.json({ baseUrl, hookUrl: hookUrl(member.tenantId), hookSecretSet: true });
  }

  async function connection(member: Member): Promise<Response> {
    const current = bitbucketConnection(await tenantNs(member.tenantId));
    if (!current) return failure(404, "bitbucket_datacenter_not_connected", "Bitbucket is not connected.");
    return Response.json({ baseUrl: current.baseUrl, hookUrl: hookUrl(member.tenantId) });
  }

  /** Webhooks triage created that could not be removed, by repository name; without `use` on the token every one is left. */
  async function removeWebhooks(member: Member, records: RepoRecord[]): Promise<string[]> {
    const hooked = records.filter((record) => record.webhookId !== undefined);
    if (hooked.length === 0) return [];
    const bb = await instance(member);
    if (bb instanceof Response) {
      deps.log({ level: "warn", msg: "bitbucket_datacenter_webhooks_left", tenantId: member.tenantId, repos: hooked.map((record) => record.name), status: bb.status });
      return hooked.map((record) => record.name);
    }
    const left: string[] = [];
    for (const record of hooked) {
      try {
        await deleteWebhook(bb, ...splitName(record.name), record.webhookId!);
      } catch (err) {
        deps.log({ level: "warn", msg: "bitbucket_datacenter_webhook_left", tenantId: member.tenantId, repo: record.name, error: String(err) });
        left.push(record.name);
      }
    }
    return left;
  }

  async function disconnectRoute(member: Member, req: Request): Promise<Response> {
    const refused = await manageRefusal(member);
    if (refused) return refused;
    const ns = await tenantNs(member.tenantId);
    // A stored connection whose URL no longer passes the check can still be removed.
    if (ns.bitbucketDatacenter === undefined) return failure(404, "bitbucket_datacenter_not_connected", "Bitbucket is not connected.");
    const webhooksLeft = await removeWebhooks(member, repoRecords(ns).filter(isBitbucketRecord));
    for (const name of [TOKEN_CREDENTIAL, HOOK_CREDENTIAL]) {
      const removeFailed = await removeCredential(req, member.tenantId, name);
      if (removeFailed) return removeFailed;
    }
    await patchCorbitsTriage(db, member.tenantId, disconnect);
    await deps.onConnectionChanged(member.tenantId);
    return Response.json({ webhooksLeft });
  }

  async function repositories(member: Member): Promise<Response> {
    const bb = await instance(member);
    if (bb instanceof Response) return bb;
    let values: unknown[];
    try {
      values = await pagedValues(bb, "/rest/api/1.0/repos");
    } catch (err) {
      return instanceFailed(err);
    }
    const names = values.map((value) => InstanceRepo.assert(value)).map((repo) => bitbucketRepoName(repo.project.key, repo.slug));
    return Response.json({ repositories: listedRepos(await tenantNs(member.tenantId), names) });
  }

  async function keptOrCreatedWebhook(bb: BitbucketFetch, member: Member, project: string, slug: string, previous: number | undefined): Promise<number | undefined | Response> {
    if (previous !== undefined && (await webhookExists(bb, project, slug, previous))) return previous;
    const secret = await secretOf(member, HOOK_CREDENTIAL);
    if (secret instanceof Response) return secret;
    return createWebhook(bb, project, slug, hookUrl(member.tenantId), secret);
  }

  async function enable(member: Member, project: string, slug: string): Promise<Response> {
    const refused = await manageRefusal(member);
    if (refused) return refused;
    const bb = await instance(member);
    if (bb instanceof Response) return bb;
    try {
      const repo = await readRepo(bb, project, slug);
      if (!repo) return failure(404, "repo_not_found", "The Bitbucket instance has no such repository, or the token cannot see it.");
      const name = bitbucketRepoName(repo.project.key, repo.slug);
      const branch = await defaultBranch(bb, repo.project.key, repo.slug);
      if (branch === undefined) return failure(409, "repo_empty", "The repository has no default branch yet. Push one first.");
      const stored = repoRecords(await tenantNs(member.tenantId)).find((record) => record.name === name);
      if (stored && !isBitbucketRecord(stored)) return failure(409, "repo_name_taken", `A GitHub repository is already named ${name}.`);
      const webhookId = await keptOrCreatedWebhook(bb, member, repo.project.key, repo.slug, stored?.webhookId);
      if (webhookId instanceof Response) return webhookId;
      const written = await patchCorbitsTriage(db, member.tenantId, async function enableBitbucketRepo(ns, tx) {
        const prev = repoRecords(ns).find((record) => isBitbucketRecord(record) && record.name === name);
        if (prev?.enabled !== true) await grantEnabledKinds(tx, member.tenantId, name, "bitbucket-datacenter", deps.now());
        return enableRepo(ns, name, branch, webhookId);
      });
      const repository = written && repoRecords(written).find((record) => record.name === name);
      if (!repository) return failure(404, "not_found", "Workspace not found.");
      deps.onEnabled(member.tenantId);
      const url = hookUrl(member.tenantId);
      if (webhookId !== undefined) return Response.json({ repository, webhook: "created", hookUrl: url });
      const hookSecret = await secretOf(member, HOOK_CREDENTIAL);
      if (hookSecret instanceof Response) return hookSecret;
      return Response.json({ repository, webhook: "manual", hookUrl: url, hookSecret, events: WEBHOOK_EVENTS }, NO_STORE);
    } catch (err) {
      return instanceFailed(err);
    }
  }

  async function webhook(member: Member, project: string, slug: string): Promise<Response> {
    const refused = await manageRefusal(member);
    if (refused) return refused;
    const name = bitbucketRepoName(project, slug);
    const stored = repoRecords(await tenantNs(member.tenantId)).find((record) => record.name === name && isBitbucketRecord(record));
    if (!stored) return failure(404, "repo_not_found", "No Bitbucket repository by that name is recorded.");
    if (stored.enabled !== true) return failure(409, "triage_off", "Triage is off for this repository.");
    if (stored.webhookId !== undefined) return Response.json({ webhook: "registered", webhookId: stored.webhookId }, NO_STORE);
    const hookSecret = await secretOf(member, HOOK_CREDENTIAL);
    if (hookSecret instanceof Response) return hookSecret;
    return Response.json({ webhook: "manual", hookUrl: hookUrl(member.tenantId), hookSecret, events: WEBHOOK_EVENTS }, NO_STORE);
  }

  async function disable(member: Member, project: string, slug: string): Promise<Response> {
    const refused = await manageRefusal(member);
    if (refused) return refused;
    const name = bitbucketRepoName(project, slug);
    const stored = repoRecords(await tenantNs(member.tenantId)).find((record) => record.name === name && isBitbucketRecord(record));
    if (!stored) return failure(404, "repo_not_found", "No Bitbucket repository by that name is recorded.");
    const webhookLeft = (await removeWebhooks(member, [stored])).length > 0;
    const written = await patchCorbitsTriage(db, member.tenantId, function disableBitbucketRepo(ns) {
      return disableRepo(ns, name);
    });
    const repository = written && repoRecords(written).find((record) => record.name === name);
    if (!repository) return failure(404, "not_found", "Workspace not found.");
    return Response.json({ repository, webhookLeft });
  }

  return { connect, connection, disconnect: disconnectRoute, repositories, enable, webhook, disable };
}

export type BitbucketHandlers = ReturnType<typeof createBitbucketIntegration>;
