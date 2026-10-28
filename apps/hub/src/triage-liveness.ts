// Whether the pull requests a workspace's hub queued still reach a manager. Each reconcile pass reads when a manager
// last took a pull request, then the oldest pull request queued since that is still waiting: a mail recorded that no
// manager has taken, or a head still queued or whose mail did not reach a listener. Once that one waited past the alarm
// age, the workspace is stalled until a manager takes again. Alarms live in process: the hub runs as one replica, and
// one restarted on a stalled workspace raises the alarm again on its first pass. Raising and clearing each email the
// workspace's owners and admins once, when the hub sends email.
import { and, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { repoPolicy } from "@corbits/triage-contracts";
import { repoRecords, sourceOf, triageNs, triageStateKey, type RepoRecord } from "./github/tenant-config.js";
import { undelivered } from "./github/triage-queue.js";
import type { TriageStateStore } from "./github/triage-state-store.js";
import { lastTakeAt, oldestPendingMail } from "./manager-state.js";

/** A stalled workspace: since when its oldest waiting pull request waits, and when a manager last took one. */
export type Stalled = { since: string; lastTakeAt?: string };

type LivenessTenant = { id: string; config: unknown };

/** What the workspace's owners and admins are emailed when its alarm is raised, or cleared. */
export type StallNotice = { to: string[]; workspace: string; since: string; cleared: boolean };

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
  /** How long a pull request may wait for a manager before the workspace counts as stalled. */
  stalledAfterMs: number;
  /** Undefined when the hub sends no email. */
  mail: ((notice: StallNotice) => Promise<void>) | undefined;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

export function createTriageLiveness(deps: TriageLivenessDeps) {
  const alarms = new Map<string, Stalled>();
  let unmailedLogged = false;

  async function email(tenantId: string, since: string, cleared: boolean): Promise<void> {
    const entry = { tenantId, since, cleared };
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
      await deps.mail({ to, workspace, since, cleared });
      deps.log({ level: "info", msg: "triage_stall_emailed", ...entry, recipients: to.length });
    } catch (err) {
      deps.log({ level: "error", msg: "triage_stall_email_failed", ...entry, error: String(err) });
    }
  }

  /** When each head of the repository queued after `after` that no manager has started was queued. */
  async function unstarted(tenantId: string, record: RepoRecord, after: number): Promise<number[]> {
    const { rows } = await deps.store.load(tenantId, triageStateKey(record));
    return rows.flatMap(function waiting(row) {
      if (row.queuedAt === undefined || Date.parse(row.queuedAt) <= after) return [];
      return row.status === "queued" || undelivered(row, sourceOf(record)) ? [Date.parse(row.queuedAt)] : [];
    });
  }

  async function stalledNow(tenant: LivenessTenant): Promise<Stalled | undefined> {
    const taken = await lastTakeAt(deps.db, tenant.id);
    const after = taken === undefined ? -Infinity : Date.parse(taken);
    const mail = await oldestPendingMail(deps.db, tenant.id, taken);
    const waiting = mail === undefined ? [] : [Date.parse(mail)];
    for (const record of repoRecords(triageNs(tenant.config))) {
      if (record.connected && repoPolicy(record).enabled) waiting.push(...await unstarted(tenant.id, record, after));
    }
    if (waiting.length === 0) return undefined;
    const since = Math.min(...waiting);
    if (deps.now().getTime() - since < deps.stalledAfterMs) return undefined;
    return { since: new Date(since).toISOString(), ...(taken !== undefined && { lastTakeAt: taken }) };
  }

  /** Raises the workspace's alarm once it stalls and clears it once a manager takes again, logging and emailing each once. */
  async function watch(tenant: LivenessTenant): Promise<void> {
    const tenantId = tenant.id;
    try {
      const stalled = await stalledNow(tenant);
      const raised = alarms.get(tenantId);
      if (stalled !== undefined) {
        alarms.set(tenantId, stalled);
        if (raised === undefined) {
          deps.log({ level: "error", msg: "triage_stalled", tenantId, ...stalled });
          await email(tenantId, stalled.since, false);
        }
      } else if (raised !== undefined) {
        alarms.delete(tenantId);
        deps.log({ level: "info", msg: "triage_stall_cleared", tenantId, since: raised.since });
        await email(tenantId, raised.since, true);
      }
    } catch (err) {
      deps.log({ level: "error", msg: "triage_liveness_failed", tenantId, error: String(err) });
    }
  }

  function stalled(tenantId: string): Stalled | undefined {
    return alarms.get(tenantId);
  }

  return { watch, stalled };
}
