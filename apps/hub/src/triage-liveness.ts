// Whether the pull requests a workspace's hub queued still reach a manager, host by host. Each check takes when a
// manager of the host last opened a pass, then the oldest of its pull requests that still waits: a mail recorded since
// that no manager has taken, a head queued since, or a head whose mail did not go out, from when it first did not,
// which no pass can have taken. Once that one waited past the alarm age, the host is stalled until nothing waits that
// long and either nothing waits at all or one of its managers opened a pass since. Alarms and takes live in process:
// the hub runs as one replica, its takes are read back as it starts, and one restarted on a stalled host raises the
// alarm again on its first check.
// Raising and clearing each email the workspace's owners and admins once, when the hub sends email.
import { and, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { REPO_SOURCES, repoPolicy, type RepoSource } from "@corbits/triage-contracts";
import { NEVER_STARTED } from "./github/reconcile-plan.js";
import { repoRecords, sourceOf, triageNs, triageStateKey } from "./github/tenant-config.js";
import { undelivered } from "./github/triage-queue.js";
import type { TriageStateStore } from "./github/triage-state-store.js";
import { lastTakes, pendingMails } from "./manager-state.js";

/** A stalled host: since when its oldest waiting pull request waits, which pull request it is, how many have waited past the alarm age, why if known, and when one of its managers last took one. */
export type Stalled = { source: RepoSource; since: string; lastTakeAt?: string; pull?: string; count?: number; reason?: string };

/** `failed` marks a head that failed to start: it keeps a raised alarm up but never raises one. */
type WaitingPull = { pull: string; at: number; reason?: string; failed?: true };

/** What the workspace's owners and admins are emailed when a host's alarm is raised, or cleared. */
export type StallNotice = { to: string[]; workspace: string; source: RepoSource; since: string; cleared: boolean };

type LivenessTenant = { id: string; config: unknown };

function hostKey(tenantId: string, source: RepoSource): string {
  return `${tenantId}\n${source}`;
}

/** When a manager of each workspace and host last opened a pass on a pull request, as the take route records it. */
export function createTakeLedger() {
  const takes = new Map<string, string>();

  function note(tenantId: string, source: RepoSource, at: string): void {
    const key = hostKey(tenantId, source);
    const last = takes.get(key);
    if (last === undefined || Date.parse(at) > Date.parse(last)) takes.set(key, at);
  }

  /** Reads back the takes the store holds, as the hub starts. */
  async function seed(db: DB["db"]): Promise<void> {
    for (const take of await lastTakes(db)) note(take.tenantId, take.source, take.at);
  }

  function last(tenantId: string, source: RepoSource): string | undefined {
    return takes.get(hostKey(tenantId, source));
  }

  return { note, seed, last };
}

export type TakeLedger = ReturnType<typeof createTakeLedger>;

/** The workspace's name and the verified addresses of its owners and admins. */
async function recipients(db: DB["db"], tenantId: string): Promise<{ workspace: string; to: string[] }> {
  const { principal, principalRole, role, tenant, user } = schema;
  const found = await db.query.tenant.findFirst({ where: eq(tenant.id, tenantId), columns: { name: true } });
  if (!found) throw new Error(`tenant ${tenantId} is gone`);
  const rows = await db
    .selectDistinct({ email: user.email })
    .from(principalRole)
    .innerJoin(role, eq(role.id, principalRole.roleId))
    .innerJoin(principal, eq(principal.id, principalRole.principalId))
    .innerJoin(user, eq(user.id, principal.refId))
    .where(and(eq(role.tenantId, tenantId), eq(role.isSystem, true), inArray(role.name, ["owner", "admin"]), eq(principal.kind, "user"), eq(principal.status, "active"), eq(user.emailVerified, true)));
  return { workspace: found.name, to: rows.map((row) => row.email).sort() };
}

export type TriageLivenessDeps = {
  db: DB["db"];
  store: Pick<TriageStateStore, "load">;
  takes: Pick<TakeLedger, "last">;
  /** How long a pull request may wait for a manager before its host counts as stalled. */
  stalledAfterMs: number;
  /** The reconciler's attempts per head: a head that failed to start with fewer is queued again. */
  maxAttempts: number;
  /** Undefined when the hub sends no email. */
  mail: ((notice: StallNotice) => Promise<void>) | undefined;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

export function createTriageLiveness(deps: TriageLivenessDeps) {
  const alarms = new Map<string, { stalled: Stalled; raisedAt: number }>();
  let unmailedLogged = false;

  async function email(tenantId: string, alarm: Stalled, cleared: boolean): Promise<void> {
    const entry = { tenantId, source: alarm.source, since: alarm.since, cleared };
    if (deps.mail === undefined) {
      if (!unmailedLogged) deps.log({ level: "warn", msg: "triage_stall_not_emailed", ...entry, reason: "SMTP_URL is not set" });
      unmailedLogged = true;
      return;
    }
    try {
      const { workspace, to } = await recipients(deps.db, tenantId);
      if (to.length === 0) {
        deps.log({ level: "warn", msg: "triage_stall_not_emailed", ...entry, reason: "no owner or admin has a verified address" });
        return;
      }
      await deps.mail({ to, workspace, source: alarm.source, since: alarm.since, cleared });
      deps.log({ level: "info", msg: "triage_stall_emailed", ...entry, recipients: to.length });
    } catch (err) {
      deps.log({ level: "error", msg: "triage_stall_email_failed", ...entry, error: String(err) });
    }
  }

  /**
   * When each waiting pull request of each host began to wait: a mail or queued head since the host's last take, and
   * any head whose mail did not go out, which no take can have picked up, until a run of it is seen. Only enabled,
   * connected repositories count. A mail counts while its pull request is open and not only failed: one without rows in a
   * repository the store has saved has closed, and a failed head waits on a new head rather than a manager. A head
   * that failed to start and will be queued again is listed too, as it cycles back to queued while managers stay down.
   */
  async function waiting(tenant: LivenessTenant): Promise<Map<RepoSource, WaitingPull[]>> {
    const byHost = new Map<RepoSource, WaitingPull[]>(REPO_SOURCES.map((source) => [source, []]));
    const mails = new Map<RepoSource, Awaited<ReturnType<typeof pendingMails>>>();
    for (const source of REPO_SOURCES) {
      mails.set(source, await pendingMails(deps.db, tenant.id, source, deps.takes.last(tenant.id, source)));
    }
    for (const record of repoRecords(triageNs(tenant.config))) {
      if (!record.connected || !repoPolicy(record).enabled) continue;
      const source = sourceOf(record);
      const taken = deps.takes.last(tenant.id, source);
      const { rows, version } = await deps.store.load(tenant.id, triageStateKey(record));
      const live = new Set(rows.filter((row) => row.status !== "failed").map((row) => row.number));
      for (const row of rows) {
        const pull = `${record.name}#${row.number}`;
        if (row.status === "failed" && row.error === NEVER_STARTED) {
          if (row.attempts < deps.maxAttempts) byHost.get(source)?.push({ pull, at: Date.parse(row.updatedAt), reason: NEVER_STARTED, failed: true });
          continue;
        }
        const since = row.undeliveredSince ?? row.queuedAt;
        if (since === undefined || (row.status !== "queued" && !undelivered(row, source))) continue;
        const unsent = row.undeliveredSince !== undefined || undelivered(row, source);
        if (unsent || taken === undefined || Date.parse(since) > Date.parse(taken)) {
          byHost.get(source)?.push({ pull, at: Date.parse(since), ...(row.error !== undefined && { reason: row.error }) });
        }
      }
      const hostMails = mails.get(source);
      if (hostMails === undefined) continue;
      for (const mail of hostMails) {
        if (mail.repo !== record.name) continue;
        const unstored = version === null && rows.length === 0;
        if (unstored || live.has(mail.number)) byHost.get(source)?.push({ pull: `${record.name}#${mail.number}`, at: Date.parse(mail.at) });
      }
    }
    return byHost;
  }

  function stalledOf(source: RepoSource, pulls: readonly WaitingPull[], taken: string | undefined): Stalled | undefined {
    const now = deps.now().getTime();
    const byPull = new Map<string, WaitingPull>();
    for (const item of pulls) {
      if (item.failed || now - item.at < deps.stalledAfterMs) continue;
      const prior = byPull.get(item.pull);
      if (prior === undefined) {
        byPull.set(item.pull, item);
        continue;
      }
      const reason = prior.reason ?? item.reason;
      byPull.set(item.pull, { pull: item.pull, at: Math.min(prior.at, item.at), ...(reason !== undefined && { reason }) });
    }
    const overdue = [...byPull.values()].sort((a, b) => a.at - b.at || a.pull.localeCompare(b.pull));
    const oldest = overdue[0];
    if (oldest === undefined) return undefined;
    return {
      source,
      since: new Date(oldest.at).toISOString(),
      ...(taken !== undefined && { lastTakeAt: taken }),
      pull: oldest.pull,
      count: overdue.length,
      ...(oldest.reason !== undefined && { reason: oldest.reason }),
    };
  }

  /**
   * Raises the host's alarm once it stalls. It clears once nothing on the host waits past the alarm age and either nothing
   * waits at all or a manager of the host opened a pass since it was raised, so heads cycling through queued and failed
   * to start while managers stay down hold it up.
   */
  async function settle(tenantId: string, source: RepoSource, pulls: readonly WaitingPull[]): Promise<void> {
    const key = hostKey(tenantId, source);
    const taken = deps.takes.last(tenantId, source);
    const stalled = stalledOf(source, pulls, taken);
    const raised = alarms.get(key);
    if (raised === undefined) {
      if (stalled === undefined) return;
      alarms.set(key, { stalled, raisedAt: deps.now().getTime() });
      deps.log({ level: "error", msg: "triage_stalled", tenantId, ...stalled });
      await email(tenantId, stalled, false);
      return;
    }
    if (stalled !== undefined) {
      alarms.set(key, { stalled, raisedAt: raised.raisedAt });
      return;
    }
    const takenSince = taken !== undefined && Date.parse(taken) > raised.raisedAt;
    if (pulls.length > 0 && !takenSince) return;
    alarms.delete(key);
    deps.log({ level: "info", msg: "triage_stall_cleared", tenantId, source, since: raised.stalled.since });
    await email(tenantId, raised.stalled, true);
  }

  /** Checks each of the workspace's hosts; one that fails is logged, so the other workspaces are still checked. */
  async function watch(tenant: LivenessTenant): Promise<void> {
    try {
      for (const [source, pulls] of await waiting(tenant)) await settle(tenant.id, source, pulls);
    } catch (err) {
      deps.log({ level: "error", msg: "triage_liveness_failed", tenantId: tenant.id, error: String(err) });
    }
  }

  let checking = false;

  /** Checks every workspace, unless the last check is still going. */
  async function check(tenants: () => Promise<LivenessTenant[]>): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      for (const tenant of await tenants()) await watch(tenant);
    } catch (err) {
      deps.log({ level: "error", msg: "triage_liveness_failed", error: String(err) });
    } finally {
      checking = false;
    }
  }

  /** The workspace's stalled hosts. */
  function stalled(tenantId: string): Stalled[] {
    return REPO_SOURCES.flatMap(function raisedOn(source) {
      const alarm = alarms.get(hostKey(tenantId, source));
      return alarm === undefined ? [] : [alarm.stalled];
    });
  }

  return { check, stalled };
}
