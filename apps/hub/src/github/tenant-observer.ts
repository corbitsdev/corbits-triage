// One read of a tenant's live pr-triage logs at a time, shared by the
// reconciler and the recording loop, and recorded as it is read, so the
// verdict route only reads tables and the last observation.
import { createHash } from "node:crypto";
import type { ActiveTenant, LiveDeployment } from "./deployment.js";
import type { RecordRuns } from "./run-recorder.js";
import { isRunning, mergeObservedRuns, observeDeployments, type ObserveRuns, type ObservedRuns } from "./triage-runs.js";

/** `observed` pairs with `deployments` by index; `workers` holds the runs of the coordinator's workers read with them. */
export type TenantObservation = { deployments: LiveDeployment[]; observed: ObservedRuns[]; workers: ObservedRuns[] };

/**
 * Bumped whenever what the portal is shown of a tenant may have changed; the verdict route's cache key. Kept in this process's
 * memory, which holds because the hub runs as one replica: a second one would record without the other's route seeing it.
 */
export type TenantVersions = { bump(tenantId: string): void; get(tenantId: string): number };

export function createTenantVersions(): TenantVersions {
  const versions = new Map<string, number>();
  return {
    bump(tenantId) {
      versions.set(tenantId, (versions.get(tenantId) ?? 0) + 1);
    },
    get(tenantId) {
      return versions.get(tenantId) ?? 0;
    },
  };
}

export type TenantObserverDeps = {
  liveDeployments: (tenantId: string) => Promise<LiveDeployment[]>;
  /** The coordinator's workers, read for their one run and never mailed or rotated. */
  workers?: {
    /** Worker deployments live or released since `endedSince`. */
    deployments: (tenantId: string, endedSince: Date) => Promise<LiveDeployment[]>;
    /** How long a released worker's log is still read: long enough for the next reconciler pass to see the run and settle its head. */
    endedWithinMs: number;
  };
  observeRuns: ObserveRuns;
  recordRuns: RecordRuns;
  versions: TenantVersions;
  minIntervalMs: number;
  now: () => Date;
};

export type TenantObserver = {
  observe(tenantId: string, domain: string): Promise<TenantObservation>;
  last(tenantId: string): TenantObservation | undefined;
};

function fingerprint(runs: ObservedRuns): string {
  const statuses = [...runs.byRepo.values()].flatMap((byHead) => [...byHead.values()].flat().map((run) => `${run.runId}:${run.status}`));
  return createHash("sha1").update(JSON.stringify([statuses.sort(), runs.verdicts])).digest("base64url");
}

export function createTenantObserver(deps: TenantObserverDeps): TenantObserver {
  const inFlight = new Map<string, Promise<TenantObservation>>();
  /** `fingerprint` is undefined after a read whose recording failed, so the next read that records bumps the version. */
  const finished = new Map<string, { at: number; observation: TenantObservation; fingerprint?: string }>();
  /** A released worker's log never changes once its run ends, so it is read once and kept until the window drops the worker. */
  const endedWorkers = new Map<string, { tenantId: string; runs: ObservedRuns }>();

  async function readWorkers(tenantId: string, domain: string): Promise<ObservedRuns[]> {
    if (!deps.workers) return [];
    const workers = await deps.workers.deployments(tenantId, new Date(deps.now().getTime() - deps.workers.endedWithinMs));
    for (const [runId, kept] of endedWorkers) {
      if (kept.tenantId === tenantId && !workers.some((worker) => worker.runId === runId)) endedWorkers.delete(runId);
    }
    const observed: ObservedRuns[] = [];
    for (const worker of workers) {
      const kept = endedWorkers.get(worker.runId);
      const runs = kept?.runs ?? (await observeDeployments(deps.observeRuns, [worker], domain))[0]!;
      if (!kept && worker.endedAt !== undefined && !isRunning(runs)) endedWorkers.set(worker.runId, { tenantId, runs });
      observed.push(runs);
    }
    return observed;
  }

  async function read(tenantId: string, domain: string): Promise<TenantObservation> {
    try {
      const deployments = await deps.liveDeployments(tenantId);
      const observed = await observeDeployments(deps.observeRuns, deployments, domain);
      const workers = await readWorkers(tenantId, domain);
      const runs = mergeObservedRuns([...observed, ...workers]);
      const recorded = await deps.recordRuns(tenantId, runs);
      const observation = { deployments, observed, workers };
      const seen = fingerprint(runs);
      if (finished.get(tenantId)?.fingerprint !== seen) deps.versions.bump(tenantId);
      finished.set(tenantId, { at: deps.now().getTime(), observation, ...(recorded && { fingerprint: seen }) });
      return observation;
    } finally {
      inFlight.delete(tenantId);
    }
  }

  return {
    observe(tenantId, domain) {
      const pending = inFlight.get(tenantId);
      if (pending) return pending;
      const last = finished.get(tenantId);
      if (last && deps.now().getTime() - last.at < deps.minIntervalMs) return Promise.resolve(last.observation);
      const reading = read(tenantId, domain);
      inFlight.set(tenantId, reading);
      return reading;
    },
    last(tenantId) {
      return finished.get(tenantId)?.observation;
    },
  };
}

export type RecordPassDeps = {
  observer: Pick<TenantObserver, "observe">;
  /** With `endedSince`, tenants whose child run ended since then count as active: a host's runs may be inserted already completed. */
  activeTenants: (what: "runs" | "deployments", endedSince?: Date) => Promise<ActiveTenant[]>;
  /** How far back an ended run still makes its tenant active; at least a pass interval, so no run's end is missed between passes. */
  endedWithinMs: number;
  backoffMs: number;
  maxBackoffMs: number;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

export type RecordPass = {
  pass: () => Promise<{ retry: boolean }>;
  /** False until the tenant's logs were read once since the hub started, if it has a live deployment; until then a run may be going unseen. */
  ready: (tenantId: string) => boolean;
};

/**
 * The recording loop: each pass reads the logs of every tenant with a run in flight, and of those that had one last pass, so a
 * verdict is recorded within a pass of its step completing and a run's end is seen. Every tenant with a live deployment when
 * the hub started is read until one read succeeds, so the runs that ended while the hub was down are seen too.
 */
export function createRecordPass(deps: RecordPassDeps): RecordPass {
  /** Tenants with a live deployment at start not read yet; undefined until they are listed. */
  let unread: Map<string, ActiveTenant> | undefined;
  let watching = new Map<string, ActiveTenant>();
  const failing = new Map<string, { failures: number; until: number }>();

  /** The tenant is then left until its backoff ends, and the failure logged once per step. */
  async function observe(tenant: ActiveTenant): Promise<{ ok: boolean; running: boolean }> {
    const backoff = failing.get(tenant.id);
    if (backoff && deps.now().getTime() < backoff.until) return { ok: false, running: true };
    try {
      const observation = await deps.observer.observe(tenant.id, tenant.domain);
      const running = [...observation.observed, ...observation.workers].some(isRunning);
      failing.delete(tenant.id);
      return { ok: true, running };
    } catch (err) {
      const failures = (backoff?.failures ?? 0) + 1;
      const waitMs = Math.min(deps.backoffMs * 2 ** (failures - 1), deps.maxBackoffMs);
      failing.set(tenant.id, { failures, until: deps.now().getTime() + waitMs });
      deps.log({ level: "error", msg: "triage_runs_unobserved", tenantId: tenant.id, failures, retryInMs: waitMs, error: String(err) });
      return { ok: false, running: true };
    }
  }

  async function pass() {
    unread ??= new Map((await deps.activeTenants("deployments")).map((tenant) => [tenant.id, tenant]));
    const active = await deps.activeTenants("runs", new Date(deps.now().getTime() - deps.endedWithinMs));
    const tenants = new Map([...unread, ...watching, ...active.map((tenant) => [tenant.id, tenant] as const)]);
    const running = new Map<string, ActiveTenant>();
    for (const tenant of tenants.values()) {
      const read = await observe(tenant);
      if (read.ok) unread.delete(tenant.id);
      if (read.running) running.set(tenant.id, tenant);
    }
    watching = running;
    return { retry: false };
  }

  return {
    pass,
    ready(tenantId) {
      return unread !== undefined && !unread.has(tenantId);
    },
  };
}
