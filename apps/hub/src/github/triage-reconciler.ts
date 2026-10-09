// Brings every open pull request on an enabled repository to a triaged head
// without relying on any webhook, sidecar or portal visit having survived:
// reads GitHub's open pull requests, the live deployments' run logs and the
// stored state, then queues what the plan says to the newest deployment.
import { repoPolicy, type CheckPack, type PrTriageRow, type RepoPolicy } from "@corbits/triage-contracts";
import { mailPayload } from "./bridge.js";
import type { CheckPackRead } from "./check-pack-store.js";
import { inFlight, planTenant, runKey, type OpenPr, type QueuedPr, type ReconcilePolicy, type RepoPlan } from "./reconcile-plan.js";
import { repoRecords, rotationRecord, triageNs, type RepoRecord, type RotationRecord } from "./tenant-config.js";
import type { OpenHeadsReader } from "./tenant-open-heads.js";
import { newestLive, type LiveDeployment, type Redeployed } from "./deployment.js";
import { mergeObservedRuns, observeDeployments, type ObserveRuns, type ObservedRuns } from "./triage-runs.js";
import { TriageStateConflictError, type LoadedTriageState, type TriageStateStore, type TriageStateVersion } from "./triage-state-store.js";

export type ReconcileTenant = { id: string; domain: string; config: unknown };

export type DeploymentRotation = {
  /** Runs a deployment's log may hold before it is replaced by a fresh copy. */
  afterRuns: number;
  redeploy: (tenantId: string, anchorRunId: string) => Promise<Redeployed>;
  sameSource: (anchorRunId: string, otherAnchorRunId: string) => Promise<boolean>;
  /** Requests cancellation; the deployment stays listed, `cancelling`, until the lifecycle sweep stops it. */
  release: (tenantId: string, anchorRunId: string) => Promise<void>;
  claim: (tenantId: string, record: RotationRecord) => Promise<boolean>;
  clear: (tenantId: string, record: RotationRecord) => Promise<void>;
};

export type TriageReconcilerDeps = {
  tenants: () => Promise<ReconcileTenant[]>;
  /** The tenant's live pr-triage deployments, newest first: the portal's and the copies the hub deploys to replace them. */
  liveDeployments: (tenantId: string) => Promise<LiveDeployment[]>;
  rotation: DeploymentRotation;
  openHeadsFor: (tenantId: string) => Promise<OpenHeadsReader | undefined>;
  observeRuns: ObserveRuns;
  store: TriageStateStore;
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>;
  deliver: (tenantId: string, address: string, payload: unknown) => Promise<void>;
  policy: ReconcilePolicy;
  /** Heads one mail carries at most. */
  batchSize: number;
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

function isRunning(runs: ObservedRuns): boolean {
  return [...runs.byRepo.values()].some((byHead) => [...byHead.values()].some((list) => list.some((run) => run.status === "running")));
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
    const heads = await pass.openHeads(repo.record);
    const prs = repo.policy.triageDrafts ? heads : heads.filter((pr) => !pr.draft);
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
    // One mail carries up to `batchSize` heads: each mail costs the deployment a fixed set of commits, whatever it carries.
    for (let from = 0; from < claimed.enqueue.length; from += deps.batchSize) {
      const batch = claimed.enqueue.slice(from, from + deps.batchSize);
      const items = batch.map((queued) => ({ prNumber: queued.number, headSha: claimed.rows.find((row) => row.number === queued.number)!.headSha }));
      try {
        await deps.deliver(pass.tenantId, pass.deployment.address, mailPayload(name, repo.policy, repo.pack, { items }));
      } catch (err) {
        const restored = claimed.enqueue.slice(from).map((queued) => ({ ...queued.undelivered, error: `delivery failed: ${String(err)}` }));
        await restoreRows(pass.tenantId, name, claimed, restored);
        return { repo: name, error: err };
      }
      for (const [i, queued] of batch.entries()) {
        deps.log({ level: "info", msg: "triage_requeued", tenantId: pass.tenantId, repo: name, pr: queued.number, headSha: items[i]!.headSha, reason: queued.reason });
      }
    }
    return undefined;
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

  /**
   * Keeps a recorded rotation, or drops it, and returns the deployment to
   * mail: the copy while the rotation stands. The replaced deployment gets no
   * new mail; it is released once its heads settled and mail it was sent has
   * had time to start, or once a head still running there counts as stuck and
   * is queued again on the copy. A deployment newer than the replaced one
   * that the hub did not make, such as the portal's of a new version,
   * supersedes the copy, which is released. The record is dropped once the
   * replaced deployment or the copy is gone, the copy is being cancelled, or
   * the copy is superseded.
   */
  async function settle(tenantId: string, record: RotationRecord, deployments: readonly LiveDeployment[], runningOn: ReadonlySet<string>, now: Date): Promise<LiveDeployment | undefined> {
    const from = deployments.find((live) => live.runId === record.from);
    const copy = deployments.find((live) => live.runId === record.to);
    const superseded = from !== undefined && deployments.some(function newer(live) {
      return live.runId !== record.from && live.runId !== record.to && !live.cancelling && live.createdAt > from.createdAt;
    });
    if (copy !== undefined && !copy.cancelling && superseded) {
      await deps.rotation.release(tenantId, copy.runId);
      deps.log({ level: "info", msg: "triage_rotation_superseded", tenantId, deployment: record.from, copy: copy.runId });
    }
    if (from === undefined || copy === undefined || copy.cancelling || superseded) {
      await deps.rotation.clear(tenantId, record);
      return newestLive(superseded ? deployments.filter((live) => live.runId !== record.to) : deployments);
    }
    const since = now.getTime() - copy.createdAt.getTime();
    const quiet = !runningOn.has(from.runId) && since >= deps.policy.unstartedAfterMs;
    if (!from.cancelling && (quiet || since > deps.policy.stuckAfterMs)) {
      await deps.rotation.release(tenantId, from.runId);
      deps.log({ level: "info", msg: "triage_deployment_released", tenantId, deployment: from.runId, replacedBy: copy.runId });
    }
    return copy;
  }

  /**
   * Two live deployments of the same source with no rotation recorded are a
   * rotation whose record was never written, or a portal redeploy whose cancel
   * of the older one failed; the newer is recorded as the older one's copy so
   * the older one is retired like any replaced deployment.
   */
  async function adopt(tenantId: string, deployments: readonly LiveDeployment[], now: Date): Promise<RotationRecord | undefined> {
    if (deployments.length !== 2 || deployments.some((live) => live.cancelling)) return undefined;
    const [newer, older] = deployments as [LiveDeployment, LiveDeployment];
    if (!await deps.rotation.sameSource(older.runId, newer.runId)) return undefined;
    const record = { from: older.runId, to: newer.runId, at: now.toISOString() };
    if (!await deps.rotation.claim(tenantId, record)) return undefined;
    deps.log({ level: "info", msg: "triage_rotation_adopted", tenantId, deployment: older.runId, copy: newer.runId });
    return record;
  }

  /**
   * Returns the deployment this pass mails. The only live deployment is
   * replaced by a copy once its log holds more than `afterRuns` runs; the
   * rotation is recorded before the copy is mailed, so a later pass, even
   * after a restart, releases only what the record names.
   */
  async function route(tenant: ReconcileTenant, deployments: readonly LiveDeployment[], observed: readonly ObservedRuns[]): Promise<LiveDeployment | undefined> {
    const now = deps.now();
    const runningOn = new Set(deployments.filter((_live, index) => isRunning(observed[index]!)).map((live) => live.runId));
    const recorded = rotationRecord(triageNs(tenant.config));
    if (recorded) return settle(tenant.id, recorded, deployments, runningOn, now);
    const adopted = await adopt(tenant.id, deployments, now);
    if (adopted) return settle(tenant.id, adopted, deployments, runningOn, now);
    const newest = newestLive(deployments);
    const runCount = observed[0]!.runCount;
    if (deployments.length !== 1 || newest === undefined || runCount <= deps.rotation.afterRuns) return newest;
    // A deployment made while this pass ran, such as the portal's of a newer version, must not be replaced by a copy of the one it superseded.
    const current = await deps.liveDeployments(tenant.id);
    if (current.length !== 1 || current[0]!.runId !== newest.runId || current[0]!.cancelling) {
      deps.log({ level: "info", msg: "triage_rotation_skipped", tenantId: tenant.id, deployment: newest.runId, reason: "deployments_changed" });
      return newestLive(current);
    }
    const redeployed = await deps.rotation.redeploy(tenant.id, newest.runId);
    if (redeployed.status === "skipped") {
      deps.log({ level: "warn", msg: "triage_rotation_skipped", tenantId: tenant.id, deployment: newest.runId, reason: redeployed.reason });
      return newest;
    }
    const record = { from: newest.runId, to: redeployed.runId, at: now.toISOString() };
    if (!await deps.rotation.claim(tenant.id, record)) {
      await deps.rotation.release(tenant.id, redeployed.runId);
      deps.log({ level: "warn", msg: "triage_rotation_skipped", tenantId: tenant.id, deployment: newest.runId, reason: "rotation_recorded" });
      return newest;
    }
    deps.log({ level: "info", msg: "triage_deployment_rotated", tenantId: tenant.id, deployment: newest.runId, replacedBy: redeployed.runId, runs: runCount });
    const after = await deps.liveDeployments(tenant.id);
    return settle(tenant.id, record, after, runningOn, now);
  }

  /** True when a delivery failed: the deployment was not routable yet, so the pass is worth repeating soon. */
  async function reconcileTenant(tenant: ReconcileTenant): Promise<boolean> {
    const repos = enabledRepos(tenant.config);
    if (repos.length === 0) return false;
    const deployments = await deps.liveDeployments(tenant.id);
    if (deployments.length === 0) {
      deps.log({ level: "warn", msg: "triage_reconcile_skipped", tenantId: tenant.id, reason: "no_live_deployment" });
      return false;
    }
    const openHeads = await deps.openHeadsFor(tenant.id);
    if (!openHeads) {
      deps.log({ level: "warn", msg: "triage_reconcile_skipped", tenantId: tenant.id, reason: "no_github_credential" });
      return false;
    }
    // Only live deployments' logs are read; heads triaged under a released one stay settled in the stored state until a live one reports a newer workflow version.
    const observed = await observeDeployments(deps.observeRuns, deployments, tenant.domain);
    let deployment = newestLive(deployments);
    try {
      deployment = await route(tenant, deployments, observed);
    } catch (err) {
      deps.log({ level: "error", msg: "triage_rotation_failed", tenantId: tenant.id, error: String(err) });
    }
    if (!deployment) {
      deps.log({ level: "warn", msg: "triage_reconcile_skipped", tenantId: tenant.id, reason: "no_live_deployment" });
      return false;
    }
    const pass: TenantPass = { tenantId: tenant.id, deployment, openHeads, runs: mergeObservedRuns(observed) };
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
