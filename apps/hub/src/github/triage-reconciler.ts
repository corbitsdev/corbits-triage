// Brings every open pull request on an enabled repository to a triaged head
// without relying on any webhook, sidecar or portal visit having survived:
// reads GitHub's open pull requests, the live deployment's run log and the
// stored state, then queues what the plan says to that deployment.
import { repoPolicy, type CheckPack, type PrTriageRow, type RepoPolicy } from "@corbits/triage-contracts";
import { mailPayload } from "./bridge.js";
import type { CheckPackRead } from "./check-pack-store.js";
import { inFlight, planTenant, runKey, type OpenPr, type QueuedPr, type ReconcilePolicy, type RepoPlan } from "./reconcile-plan.js";
import { repoRecords, triageNs, type RepoRecord } from "./tenant-config.js";
import type { OpenHeadsReader } from "./tenant-open-heads.js";
import type { ObservedRuns } from "./triage-runs.js";
import { TriageStateConflictError, type LoadedTriageState, type TriageStateStore, type TriageStateVersion } from "./triage-state-store.js";

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
type LoadedRepo = EnabledRepo & { pack: CheckPack; prs: OpenPr[]; stored: LoadedTriageState };
type Failure = { repo: string; error: unknown };

/** `retry` asks for another pass soon: a deployment was not routable yet. */
export type ReconcileOutcome = { retry: boolean };

function enabledRepos(config: unknown): EnabledRepo[] {
  return repoRecords(triageNs(config)).flatMap(function enabled(record) {
    const policy = repoPolicy(record);
    return record.connected && policy.enabled ? [{ record, policy }] : [];
  });
}

type Claimed = { rows: PrTriageRow[]; version: TriageStateVersion; enqueue: QueuedPr[] };

function headKey(row: Pick<PrTriageRow, "number" | "headSha">): string {
  return runKey(row.number, row.headSha);
}

/** The rows with each of `replacements` standing in for the row of its head. */
function withHeads(rows: readonly PrTriageRow[], replacements: readonly PrTriageRow[]): PrTriageRow[] {
  const byHead = new Map(replacements.map((row) => [headKey(row), row]));
  return rows.map((row) => byHead.get(headKey(row)) ?? row);
}

/** Theirs in their order, each head replaced by ours only when ours is newer; heads only we have follow. */
function mergeRows(theirs: readonly PrTriageRow[], ours: readonly PrTriageRow[]): PrTriageRow[] {
  const byHead = new Map(ours.map((row) => [headKey(row), row]));
  const merged = theirs.map(function newer(row) {
    const mine = byHead.get(headKey(row));
    byHead.delete(headKey(row));
    return mine !== undefined && new Date(mine.updatedAt).getTime() > new Date(row.updatedAt).getTime() ? mine : row;
  });
  return [...merged, ...byHead.values()];
}

export function createTriageReconciler(deps: TriageReconcilerDeps) {
  async function loadRepo(pass: TenantPass, repo: EnabledRepo): Promise<LoadedRepo | undefined> {
    const read = await deps.readCheckPack(pass.tenantId, repo.record.name);
    if (read.status !== "ok") return undefined;
    const prs = await pass.openHeads(repo.record);
    const stored = await deps.store.load(pass.tenantId, repo.record.name);
    return { ...repo, pack: read.pack, prs, stored };
  }

  /**
   * Writes the plan's queued heads before any mail goes out, so a request
   * arriving meanwhile sees them queued. When someone wrote first, their rows
   * are reloaded and a head they already queued or started is left to them;
   * refused again, nothing is mailed this pass.
   */
  async function claim(tenantId: string, repo: string, stored: LoadedTriageState, plan: RepoPlan): Promise<Claimed | undefined> {
    const claimed = { rows: plan.rows, version: stored.version, enqueue: plan.enqueue };
    if (JSON.stringify(plan.rows) === JSON.stringify(stored.rows)) return claimed;
    try {
      return { ...claimed, version: await deps.store.save(tenantId, repo, plan.rows, stored.version) };
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
    }
    const fresh = await deps.store.load(tenantId, repo);
    const theirs = new Map(fresh.rows.map((row) => [headKey(row), row]));
    const headOf = (queued: QueuedPr) => headKey(plan.rows.find((row) => row.number === queued.number)!);
    const left = new Set(plan.enqueue.map(headOf).filter((key) => theirs.has(key) && inFlight(theirs.get(key)!)));
    const rows = mergeRows(fresh.rows, plan.rows.filter((row) => !left.has(headKey(row))));
    try {
      const version = await deps.store.save(tenantId, repo, rows, fresh.version);
      deps.log({ level: "info", msg: "triage_state_merged", tenantId, repo, left: left.size });
      return { rows, version, enqueue: plan.enqueue.filter((queued) => !left.has(headOf(queued))) };
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
      deps.log({ level: "warn", msg: "triage_state_conflict", tenantId, repo });
      return undefined;
    }
  }

  /** Puts back the rows of heads whose mail did not go out; refused as stale, it is retried once on a fresh load. */
  async function restoreRows(tenantId: string, repo: string, claimed: Claimed, restored: PrTriageRow[]): Promise<void> {
    try {
      await deps.store.save(tenantId, repo, withHeads(claimed.rows, restored), claimed.version);
      return;
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
    }
    const fresh = await deps.store.load(tenantId, repo);
    await deps.store.save(tenantId, repo, withHeads(fresh.rows, restored), fresh.version);
  }

  /** Deliveries stop for the tenant once one fails: the failure is passed on so later repositories keep their heads unqueued. */
  async function deliverRepo(pass: TenantPass, repo: LoadedRepo, plan: RepoPlan, failed: Failure | undefined): Promise<Failure | undefined> {
    const name = repo.record.name;
    if (failed !== undefined) {
      await saveRows(pass.tenantId, name, repo.stored, withHeads(plan.rows, plan.enqueue.map((queued) => queued.undelivered)));
      return failed;
    }
    const claimed = await claim(pass.tenantId, name, repo.stored, plan);
    if (claimed === undefined) return undefined;
    let failure: Failure | undefined;
    const restored: PrTriageRow[] = [];
    for (const queued of claimed.enqueue) {
      const headSha = claimed.rows.find((row) => row.number === queued.number)!.headSha;
      if (failure !== undefined) {
        restored.push(queued.undelivered);
        continue;
      }
      try {
        await deps.deliver(pass.tenantId, pass.deployment.address, mailPayload(name, repo.policy, repo.pack, { prNumber: queued.number, headSha }));
        deps.log({ level: "info", msg: "triage_requeued", tenantId: pass.tenantId, repo: name, pr: queued.number, headSha, reason: queued.reason });
      } catch (err) {
        failure = { repo: name, error: err };
        restored.push({ ...queued.undelivered, error: `delivery failed: ${String(err)}` });
      }
    }
    if (restored.length > 0) await restoreRows(pass.tenantId, name, claimed, restored);
    return failure;
  }

  /** A save refused because someone else wrote first is retried once on their rows, keeping the newer row of each head; refused again, it waits for the next pass. */
  async function saveRows(tenantId: string, repo: string, stored: LoadedTriageState, rows: PrTriageRow[]): Promise<void> {
    if (JSON.stringify(rows) === JSON.stringify(stored.rows)) return;
    try {
      await deps.store.save(tenantId, repo, rows, stored.version);
      return;
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
    }
    const fresh = await deps.store.load(tenantId, repo);
    try {
      await deps.store.save(tenantId, repo, mergeRows(fresh.rows, rows), fresh.version);
      deps.log({ level: "info", msg: "triage_state_merged", tenantId, repo });
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
      deps.log({ level: "warn", msg: "triage_state_conflict", tenantId, repo });
    }
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
    // Only the live deployment's log is read; heads triaged under an earlier one stay settled in the stored state until this one reports a newer workflow version.
    const pass: TenantPass = { tenantId: tenant.id, deployment, openHeads, runs: await deps.observeRuns(deployment.runId, tenant.domain) };
    const loaded: LoadedRepo[] = [];
    for (const repo of repos) {
      try {
        const repoLoaded = await loadRepo(pass, repo);
        if (repoLoaded) loaded.push(repoLoaded);
      } catch (err) {
        deps.log({ level: "error", msg: "triage_reconcile_failed", tenantId: tenant.id, repo: repo.record.name, error: String(err) });
      }
    }
    const plans = planTenant({
      repos: loaded.map((repo) => ({ name: repo.record.name, prs: repo.prs, rows: repo.stored.rows })),
      runs: pass.runs.byRepo,
      now: deps.now(),
      policy: deps.policy,
      workflowVersion: pass.runs.workflowVersion,
    });
    let failure: Failure | undefined;
    for (const repo of loaded) {
      try {
        failure = await deliverRepo(pass, repo, plans.get(repo.record.name)!, failure);
      } catch (err) {
        failure = { repo: repo.record.name, error: err };
      }
    }
    if (failure === undefined) return false;
    deps.log({ level: "error", msg: "triage_reconcile_failed", tenantId: tenant.id, repo: failure.repo, error: String(failure.error) });
    return true;
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
