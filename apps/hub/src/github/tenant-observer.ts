// One read of a tenant's live pr-triage logs at a time, shared by the
// reconciler and the recording loop, and recorded as it is read, so the
// verdict route only reads tables and the last observation.
import { createHash } from "node:crypto";
import type { ActiveTenant, LiveDeployment } from "./deployment.js";
import type { RecordRuns } from "./run-recorder.js";
import { mergeObservedRuns, observeDeployments, type ObserveRuns, type ObservedRuns } from "./triage-runs.js";

export type TenantObservation = { deployments: LiveDeployment[]; observed: ObservedRuns[] };

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
  observeRuns: ObserveRuns;
  recordRuns: RecordRuns;
  versions: TenantVersions;
  /** A read finished less recently than this is reused rather than read again. */
  minIntervalMs: number;
  now: () => Date;
};

export type TenantObserver = {
  /** Reads and records the live deployments' runs; a caller while a read is in flight shares it. */
  observe(tenantId: string, domain: string): Promise<TenantObservation>;
  /** The last finished read, without reading. */
  last(tenantId: string): TenantObservation | undefined;
};

/** What the portal shows of the runs: each one's status, and every verdict as recorded, its posted reply and Do outcomes included. */
function fingerprint(runs: ObservedRuns): string {
  const statuses = [...runs.byRepo.values()].flatMap((byHead) => [...byHead.values()].flat().map((run) => `${run.runId}:${run.status}`));
  return createHash("sha1").update(JSON.stringify([statuses.sort(), runs.verdicts])).digest("base64url");
}

export function createTenantObserver(deps: TenantObserverDeps): TenantObserver {
  const inFlight = new Map<string, Promise<TenantObservation>>();
  /** `fingerprint` is undefined after a read whose recording failed, so the next read that records bumps the version. */
  const finished = new Map<string, { at: number; observation: TenantObservation; fingerprint?: string }>();

  async function read(tenantId: string, domain: string): Promise<TenantObservation> {
    try {
      const deployments = await deps.liveDeployments(tenantId);
      const observed = await observeDeployments(deps.observeRuns, deployments, domain);
      const runs = mergeObservedRuns(observed);
      const recorded = await deps.recordRuns(tenantId, runs);
      const observation = { deployments, observed };
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
  /** Tenants with a pr-triage run in flight, or with `deployments` a live pr-triage deployment. */
  activeTenants: (what: "runs" | "deployments") => Promise<ActiveTenant[]>;
  /** A tenant whose read failed is left this long, doubling per failure up to `maxBackoffMs`. */
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

function isRunning(observation: TenantObservation): boolean {
  return observation.observed.some((runs) => [...runs.byRepo.values()].some((byHead) => [...byHead.values()].some((list) => list.some((run) => run.status === "running"))));
}

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

  /** False when the read failed; the tenant is then left until its backoff ends, and the failure logged once per step. */
  async function observe(tenant: ActiveTenant): Promise<{ ok: boolean; running: boolean }> {
    const backoff = failing.get(tenant.id);
    if (backoff && deps.now().getTime() < backoff.until) return { ok: false, running: true };
    try {
      const running = isRunning(await deps.observer.observe(tenant.id, tenant.domain));
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
    const active = await deps.activeTenants("runs");
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
