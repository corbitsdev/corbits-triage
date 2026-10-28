// Whether the pull requests a workspace's hub queued still reach a manager, host by host. Each check takes when a
// manager of the host last took a pull request, then the oldest of its pull requests queued since that still waits: a
// mail recorded that no manager has taken, or a head still queued or whose mail did not go out, from when it first did
// not. Once that one waited past the alarm age, the host is stalled until one of its managers takes a pull request
// again. Alarms and takes live in process: the hub runs as one replica, its takes are read back as it starts, and one
// restarted on a stalled host raises the alarm again on its first check. Raising and clearing each email the
// workspace's owners and admins once, when the hub sends email.
import { and, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { REPO_SOURCES, repoPolicy, type RepoSource } from "@corbits/triage-contracts";
import { repoRecords, sourceOf, triageNs, triageStateKey } from "./github/tenant-config.js";
import { undelivered } from "./github/triage-queue.js";
import type { TriageStateStore } from "./github/triage-state-store.js";
import { lastTakes, oldestPendingMail } from "./manager-state.js";

/** A stalled host: since when its oldest waiting pull request waits, and when one of its managers last took one. */
export type Stalled = { source: RepoSource; since: string; lastTakeAt?: string };

/** What the workspace's owners and admins are emailed when a host's alarm is raised, or cleared. */
export type StallNotice = { to: string[]; workspace: string; source: RepoSource; since: string; cleared: boolean };

type LivenessTenant = { id: string; config: unknown };

function hostKey(tenantId: string, source: RepoSource): string {
  return `${tenantId}\n${source}`;
}

/** When a manager of each workspace and host last took a pull request, as the take route records it. */
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
  /** Undefined when the hub sends no email. */
  mail: ((notice: StallNotice) => Promise<void>) | undefined;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

export function createTriageLiveness(deps: TriageLivenessDeps) {
  const alarms = new Map<string, Stalled>();
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

  /** When each pull request of each host queued after that host's last take began to wait. */
  async function waiting(tenant: LivenessTenant): Promise<Map<RepoSource, number[]>> {
    const byHost = new Map<RepoSource, number[]>();
    for (const source of REPO_SOURCES) {
      const mail = await oldestPendingMail(deps.db, tenant.id, source, deps.takes.last(tenant.id, source));
      byHost.set(source, mail === undefined ? [] : [Date.parse(mail)]);
    }
    for (const record of repoRecords(triageNs(tenant.config))) {
      if (!record.connected || !repoPolicy(record).enabled) continue;
      const source = sourceOf(record);
      const taken = deps.takes.last(tenant.id, source);
      const { rows } = await deps.store.load(tenant.id, triageStateKey(record));
      for (const row of rows) {
        const since = row.undeliveredSince ?? row.queuedAt;
        if (since === undefined || (taken !== undefined && Date.parse(since) <= Date.parse(taken))) continue;
        if (row.status === "queued" || undelivered(row, source)) byHost.get(source)?.push(Date.parse(since));
      }
    }
    return byHost;
  }

  /** Raises the host's alarm once it stalls, and clears it only once one of its managers took a pull request since. */
  async function settle(tenantId: string, source: RepoSource, times: readonly number[]): Promise<void> {
    const key = hostKey(tenantId, source);
    const taken = deps.takes.last(tenantId, source);
    const oldest = times.length === 0 ? undefined : Math.min(...times);
    const stalled: Stalled | undefined = oldest === undefined || deps.now().getTime() - oldest < deps.stalledAfterMs
      ? undefined
      : { source, since: new Date(oldest).toISOString(), ...(taken !== undefined && { lastTakeAt: taken }) };
    const raised = alarms.get(key);
    if (raised === undefined) {
      if (stalled === undefined) return;
      alarms.set(key, stalled);
      deps.log({ level: "error", msg: "triage_stalled", tenantId, ...stalled });
      await email(tenantId, stalled, false);
      return;
    }
    if (taken === undefined || Date.parse(taken) <= Date.parse(raised.since)) return;
    if (stalled !== undefined) {
      alarms.set(key, stalled);
      return;
    }
    alarms.delete(key);
    deps.log({ level: "info", msg: "triage_stall_cleared", tenantId, source, since: raised.since });
    await email(tenantId, raised, true);
  }

  /** Checks each of the workspace's hosts; one that fails is logged, so the other workspaces are still checked. */
  async function watch(tenant: LivenessTenant): Promise<void> {
    try {
      for (const [source, times] of await waiting(tenant)) await settle(tenant.id, source, times);
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
    return REPO_SOURCES.flatMap((source) => alarms.get(hostKey(tenantId, source)) ?? []);
  }

  return { check, stalled };
}
