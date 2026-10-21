// Webhook intake for providers other than GitHub, which keeps its own bridge. A provider is a descriptor: which
// tenant credential holds its hook secret, which headers carry its X-Hub-Signature, event and delivery id, and a pure
// normaliser that turns its payload into the shapes the GitHub bridge produces. Everything after verification is
// shared and has no provider branches. A failed queue write is 500 so the provider retries.
import { hasEnabledRules, repoPolicy, triageEventOf, type RepoSource } from "@corbits/triage-contracts";
import { errorText, isRecord } from "@corbits/common";
import type { HookHeaders } from "@corbits/common/hook-metadata";
import { verifyXHubSignature } from "@corbits/common/x-hub-signature";
import { loadBridgeHook, logJson, resolvedPack, tenantConfigOf, type BridgeDeps, type BridgeHook } from "../github/bridge.js";
import type { Accepted } from "../github/coalescer.js";
import type { BaseMove, PolicyPush, PrMail } from "../github/normalize.js";
import { repoRecords, sourceOf, triageNs, triageStateKey, type CorbitsTriageNs, type RepoRecord } from "../github/tenant-config.js";
import { readCappedBody } from "../read-json.js";

export type HookIntake =
  | { kind: "pr"; mail: PrMail }
  | { kind: "base-move"; move: BaseMove }
  /** `branches` names the branches the push updated when the payload does not say which is the default one. */
  | { kind: "policy-push"; push: PolicyPush; branches?: string[] };

export type ProviderHook = {
  source: RepoSource;
  /** Tenant credential holding the hook secret, with metadata.webhook naming the workflow. */
  credential: string;
  headers: HookHeaders;
  normalize: (event: string, deliveryId: string, payload: Record<string, unknown>) => HookIntake | null;
  /** The user the tenant's token acts as, whose own events must not wake triage. */
  ownUser?: (ns: CorbitsTriageNs) => string | undefined;
};

export type ProviderHookDeps = Pick<BridgeDeps, "db" | "cipher" | "cache" | "coalescer" | "codeReview" | "log" | "readCheckPack" | "recheckOpenPulls" | "refreshPolicyFile">;

type Delivery = { hook: BridgeHook; delivery: string; event: string; record: RepoRecord; ns: CorbitsTriageNs };

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function repoOf(intake: HookIntake): string {
  if (intake.kind === "pr") return intake.mail.repo;
  if (intake.kind === "base-move") return intake.move.repo;
  return intake.push.repo;
}

export function createProviderHookHandler(d: ProviderHookDeps) {
  const log = d.log ?? logJson;

  function failed(at: Delivery, status: number, error: string, cause: unknown): Response {
    d.cache.forget(`${at.hook.credentialId}:${at.delivery}`);
    log({ level: "error", msg: error, delivery: at.delivery, event: at.event, repo: at.record.name, error: errorText(cause) });
    return json(status, { error });
  }

  function ignored(at: Delivery, reason: string, extra: Record<string, unknown> = {}): Response {
    log({ level: "info", msg: "ignored", delivery: at.delivery, event: at.event, repo: at.record.name, hook: at.hook.credentialId, reason, ...extra });
    return json(202, { status: "ignored" });
  }

  async function policyPush(at: Delivery, { repo }: PolicyPush): Promise<Response> {
    let read: Awaited<ReturnType<ProviderHookDeps["refreshPolicyFile"]>>;
    try {
      read = await d.refreshPolicyFile(at.hook.tenantId, repo, sourceOf(at.record));
    } catch (err) {
      return failed(at, 500, "policy_file_read_failed", err);
    }
    if (!read) return ignored(at, "unconfigured_repo");
    log({ level: "info", msg: "policy_file_pushed", delivery: at.delivery, event: at.event, repo, status: read.status, hook: at.hook.credentialId });
    return json(202, { status: "accepted" });
  }

  /** A moved base branch can change every other open pull request's conflicts, so they are triaged again; the merged one is not. */
  async function baseMove(at: Delivery, { repo, merged }: BaseMove): Promise<Response> {
    let due: number;
    try {
      due = await d.recheckOpenPulls(at.hook.tenantId, triageStateKey(at.record), merged);
    } catch (err) {
      return failed(at, 500, "triage_state_unavailable", err);
    }
    log({ level: "info", msg: "base_moved", delivery: at.delivery, event: at.event, repo, merged, due, hook: at.hook.credentialId });
    return json(202, { status: "accepted" });
  }

  async function pullRequest(at: Delivery, mail: PrMail, provider: ProviderHook): Promise<Response> {
    const triageEvent = triageEventOf(mail);
    if (mail.prNumber === null || triageEvent === null) return ignored(at, "no_triage_event", { action: mail.action });
    if (mail.actor && provider.ownUser?.(at.ns) === mail.actor) return ignored(at, "own_actor", { actor: mail.actor });
    // Its conversion to draft is triaged once, so the verdict stops offering it as ready.
    if (mail.draft === true && mail.action !== "converted_to_draft") return ignored(at, "draft", { pr: mail.prNumber });
    if (mail.headSha === null) return ignored(at, "not_open", { pr: mail.prNumber });
    let stored: Awaited<ReturnType<typeof resolvedPack>>;
    try {
      stored = await resolvedPack(d.readCheckPack, at.hook.tenantId, at.record.name, sourceOf(at.record));
    } catch (err) {
      return failed(at, 500, "policy_read_failed", err);
    }
    if (!stored) {
      log({ level: "info", msg: "needs_setup", delivery: at.delivery, event: at.event, repo: at.record.name, hook: at.hook.credentialId });
      return json(202, { status: "needs-setup" });
    }
    if (!hasEnabledRules(stored.pack)) {
      log({ level: "info", msg: "triage_skipped_no_rules", delivery: at.delivery, event: at.event, repo: at.record.name, pr: mail.prNumber, headSha: mail.headSha, hook: at.hook.credentialId });
      return json(202, { status: "ignored" });
    }
    let accepted: Accepted;
    try {
      accepted = await d.coalescer.accept({
        tenantId: at.hook.tenantId,
        workflow: at.hook.workflow,
        record: at.record,
        policy: repoPolicy(at.record),
        pack: stored.pack,
        automatic: stored.automatic,
        source: stored.source,
        mail,
        number: mail.prNumber,
        headSha: mail.headSha,
        event: triageEvent,
      });
    } catch (err) {
      return failed(at, 500, "triage_state_unavailable", err);
    }
    log({ level: "info", msg: accepted, delivery: at.delivery, event: at.event, action: mail.action, repo: mail.repo, pr: mail.prNumber, headSha: mail.headSha, workflow: at.hook.workflow });
    return json(202, { status: accepted });
  }

  return async function handleProviderHook(req: Request, provider: ProviderHook, tenantId: string): Promise<Response> {
    let hook: BridgeHook | undefined;
    try {
      hook = await loadBridgeHook(d.db, d.cipher, provider.credential, tenantId);
    } catch {
      return json(500, { error: "vault_error" });
    }
    if (!hook) return json(404, { error: "unknown_hook" });
    const body = await readCappedBody(req);
    if (body === null) {
      log({ level: "warn", msg: "payload_too_large", hook: hook.credentialId });
      return json(413, { error: "payload_too_large" });
    }
    const delivery = req.headers.get(provider.headers.delivery);
    const event = req.headers.get(provider.headers.event);
    if (!verifyXHubSignature(hook.secret, req.headers.get(provider.headers.signature), body)) {
      log({ level: "warn", msg: "bad_signature", delivery, hook: hook.credentialId });
      return json(401, { error: "invalid_signature" });
    }
    if (!delivery || !event) return json(400, { error: "missing_headers" });
    const key = `${hook.credentialId}:${delivery}`;
    if (d.cache.check(key)) {
      log({ level: "info", msg: "duplicate", delivery, event, hook: hook.credentialId });
      return json(200, { status: "duplicate" });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = undefined;
    }
    if (!isRecord(payload)) {
      d.cache.forget(key);
      return json(400, { error: "invalid_json" });
    }
    const intake = provider.normalize(event, delivery, payload);
    if (!intake) {
      log({ level: "info", msg: "ignored", delivery, event, hook: hook.credentialId });
      return json(202, { status: "ignored" });
    }
    let tenantConfig: unknown;
    try {
      tenantConfig = await tenantConfigOf(d, hook.tenantId);
    } catch {
      d.cache.forget(key);
      return json(500, { error: "tenant_config_unavailable" });
    }
    const repo = repoOf(intake);
    const ns = triageNs(tenantConfig);
    const record = repoRecords(ns).find((row) => sourceOf(row) === provider.source && row.name === repo && row.connected);
    if (!record) {
      log({ level: "info", msg: "unknown_repo", delivery, event, repo, hook: hook.credentialId });
      return json(404, { error: "unknown_repo" });
    }
    const at = { hook, delivery, event, record, ns };
    if (intake.kind === "policy-push") {
      if (intake.branches && (record.defaultBranch === undefined || !intake.branches.includes(record.defaultBranch))) return ignored(at, "not_default_branch", { branches: intake.branches });
      return policyPush(at, intake.push);
    }
    if (intake.kind === "pr") void d.codeReview.offer(hook.tenantId, record, intake.mail);
    if (!repoPolicy(record).enabled) return ignored(at, "repo_not_enabled");
    if (intake.kind === "base-move") return baseMove(at, intake.move);
    return pullRequest(at, intake.mail, provider);
  };
}
