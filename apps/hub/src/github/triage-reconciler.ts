// Brings every open pull request on an enabled repository to a triaged head
// without relying on any webhook, sidecar or portal visit having survived:
// reads GitHub's open pull requests, the live deployment's run log and the
// stored state, then queues what the plan says to that deployment.
import { repoPolicy, type CheckPack, type RepoPolicy } from "@corbits/triage-contracts";
import { mailPayload } from "./bridge.js";
import type { CheckPackRead } from "./check-pack-store.js";
import { planRepo, type ReconcilePolicy } from "./reconcile-plan.js";
import { repoRecords, triageNs, type RepoRecord } from "./tenant-config.js";
import type { OpenHeadsReader } from "./tenant-open-heads.js";
import type { ObservedRuns } from "./triage-runs.js";
import type { TriageStateStore } from "./triage-state-store.js";

export type ReconcileTenant = { id: string; domain: string; config: unknown };
export type LiveDeployment = { runId: string; address: string };

export type TriageReconcilerDeps = {
  tenants: () => Promise<ReconcileTenant[]>;
  /** The tenant's live pr-triage deployment; the hub never deploys one itself. */
  liveDeployment: (tenantId: string) => Promise<LiveDeployment | null>;
  openHeadsFor: (tenantId: string) => Promise<OpenHeadsReader | undefined>;
  observeRuns: (anchorRunId: string, domain: string) => Promise<ObservedRuns>;
  store: TriageStateStore;
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>;
  deliver: (tenantId: string, address: string, payload: unknown) => Promise<void>;
  policy: ReconcilePolicy;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

type EnabledRepo = { record: RepoRecord; policy: RepoPolicy };
type TenantPass = { tenantId: string; deployment: LiveDeployment; openHeads: OpenHeadsReader; runs: ObservedRuns };

/** Deliveries stop for the tenant once one fails: its deployment is unreachable until a later pass. */
class DeliveryFailed extends Error {}

/** `retry` asks for another pass soon: a deployment was not routable yet. */
export type ReconcileOutcome = { retry: boolean };

function enabledRepos(config: unknown): EnabledRepo[] {
  return repoRecords(triageNs(config)).flatMap(function enabled(record) {
    const policy = repoPolicy(record);
    return record.connected && policy.enabled ? [{ record, policy }] : [];
  });
}

export function createTriageReconciler(deps: TriageReconcilerDeps) {
  async function reconcileRepo(pass: TenantPass, repo: EnabledRepo, pack: CheckPack): Promise<void> {
    const name = repo.record.name;
    const prs = await pass.openHeads(repo.record);
    const stored = await deps.store.load(pass.tenantId, name);
    const plan = planRepo({ prs, rows: stored, runs: pass.runs.get(name) ?? new Map(), now: deps.now(), policy: deps.policy });
    const rows = [...plan.rows];
    let failure: unknown;
    for (const queued of plan.enqueue) {
      const index = rows.findIndex((row) => row.number === queued.number);
      const headSha = rows[index]!.headSha;
      if (failure !== undefined) {
        rows[index] = queued.undelivered;
        continue;
      }
      try {
        await deps.deliver(pass.tenantId, pass.deployment.address, mailPayload(name, repo.policy, pack, { prNumber: queued.number, headSha }));
        deps.log({ level: "info", msg: "triage_requeued", tenantId: pass.tenantId, repo: name, pr: queued.number, headSha });
      } catch (err) {
        failure = err;
        rows[index] = { ...queued.undelivered, error: `delivery failed: ${String(err)}` };
      }
    }
    if (JSON.stringify(rows) !== JSON.stringify(stored)) await deps.store.save(pass.tenantId, name, rows);
    if (failure !== undefined) throw new DeliveryFailed(String(failure));
  }

  /** True when a delivery failed: the deployment was not routable yet, so the pass is worth repeating soon. */
  async function reconcileTenant(tenant: ReconcileTenant): Promise<boolean> {
    const repos = enabledRepos(tenant.config);
    if (repos.length === 0) return false;
    const deployment = await deps.liveDeployment(tenant.id);
    if (!deployment) {
      deps.log({ level: "warn", msg: "triage_reconcile_skipped", tenantId: tenant.id, reason: "no_live_deployment" });
      return false;
    }
    const openHeads = await deps.openHeadsFor(tenant.id);
    if (!openHeads) {
      deps.log({ level: "warn", msg: "triage_reconcile_skipped", tenantId: tenant.id, reason: "no_github_credential" });
      return false;
    }
    // Only the live deployment's log is read; heads triaged under an earlier one are already settled in the stored state.
    const pass = { tenantId: tenant.id, deployment, openHeads, runs: await deps.observeRuns(deployment.runId, tenant.domain) };
    for (const repo of repos) {
      const read = await deps.readCheckPack(tenant.id, repo.record.name);
      if (read.status !== "ok") continue;
      try {
        await reconcileRepo(pass, repo, read.pack);
      } catch (err) {
        deps.log({ level: "error", msg: "triage_reconcile_failed", tenantId: tenant.id, repo: repo.record.name, error: String(err) });
        if (err instanceof DeliveryFailed) return true;
      }
    }
    return false;
  }

  return async function reconcileTriage(): Promise<ReconcileOutcome> {
    let retry = false;
    for (const tenant of await deps.tenants()) {
      try {
        if (await reconcileTenant(tenant)) retry = true;
      } catch (err) {
        deps.log({ level: "error", msg: "triage_reconcile_failed", tenantId: tenant.id, error: String(err) });
      }
    }
    return { retry };
  };
}
