// What the workspace already recorded, as one list newest first: verdicts and
// the Dos their runs ran, held Do approvals, check pack versions, members,
// grants and workflow deployments. Nothing is written for the log.
import { and, desc, eq, gte, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { type } from "arktype";
import { findArtifactByTitle, listArtifactVersions, type ArtifactDb } from "@corbits/artifacts";
import { checkPackName, type AuditEntry, type AuditLog } from "@corbits/triage-contracts";
import { schema, type DB } from "@intx/db";
import { formatRunAddress } from "@intx/types";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunReader } from "@intx/hub-sessions";
import { ROTATION_REASON } from "./github/deployment.js";
import { failure } from "./github/portal-credential.js";
import { repoRecords, triageNs } from "./github/tenant-config.js";
import { approvalIn, type Approval } from "./github/triage-runs.js";
import { verdictRecord, type VerdictRecord } from "./github/verdict-record-store.js";
import type { Member } from "./integrations/app.js";

export const AUDIT_PATH = "/api/integrations/audit";

const DEFAULT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;
/** Run logs read at most per request when looking for approvals. */
const APPROVAL_READS = 200;
const TRIAGE = "Triage";
const HUB = "hub";
const UNKNOWN = "unknown";

const AuditQuery = type({
  "repo?": /^[\w.-]+\/[\w.-]+$/,
  "since?": "string.date.iso.parse",
  "limit?": type("string.integer.parse").to(`1 <= number.integer <= ${MAX_AUDIT_LIMIT}`),
});

const DO_OUTCOMES: Record<string, string> = { done: "Ran", satisfied: "Found done", failed: "Failed", skipped: "Could not run" };

type Entry = Omit<AuditEntry, "time"> & { at: Date };
/** `people` is whether the caller may read the workspace's principals, which emails and members need. */
type Window = { tenantId: string; repo?: string; since?: Date; limit: number; people: boolean };

export type AuditLogDeps = {
  db: DB["db"];
  /** The same database, as the artifact store reads it. */
  artifacts: ArtifactDb;
  runReader: Pick<WorkflowRunReader, "readRunEvents">;
  /** Whether two deployments run the same workflow source. */
  sameSource: (anchorRunId: string, otherAnchorRunId: string) => Promise<boolean>;
  authorize: (principalId: string, tenantId: string, resource: string, action: string) => Promise<boolean>;
  /** The workflow whose runs make verdicts and approvals. */
  workflow: string;
};

function after(column: Parameters<typeof gte>[0], since: Date | undefined): SQL | undefined {
  return since === undefined ? undefined : gte(column, since);
}

function pull(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** `rows` is newest first. A held Do's outcome shows on its approval instead; any other Do shows once, with its newest outcome. */
function verdictEntries(rows: readonly VerdictRecord[]): Entry[] {
  const entries: Entry[] = [];
  const stateOf = new Map<string, string>();
  for (const verdict of rows.toReversed()) {
    const target = pull(verdict.repo, verdict.number);
    const before = stateOf.get(target);
    stateOf.set(target, verdict.state);
    const state = before === undefined || before === verdict.state ? verdict.state : `${before} → ${verdict.state}`;
    const degraded = verdict.degraded === null ? "" : ` · degraded: ${verdict.degraded}`;
    entries.push({ at: verdict.verdictAt, actor: TRIAGE, action: "Triaged", target, detail: `${state}${degraded} · head ${verdict.headSha.slice(0, 7)}` });
  }
  const ran = new Set<string>();
  for (const verdict of rows) {
    const target = pull(verdict.repo, verdict.number);
    for (const action of verdict.detail?.actions ?? []) {
      const outcome = DO_OUTCOMES[action.status ?? ""];
      if (outcome === undefined || action.held || action.effectId === undefined || ran.has(action.effectId)) continue;
      ran.add(action.effectId);
      entries.push({ at: verdict.verdictAt, actor: TRIAGE, action: `${outcome} ${action.kind ?? "Do"}`, target, detail: action.error ?? (action.list === undefined ? "" : `on ${action.list}`) });
    }
  }
  return entries;
}

function approvalOutcome(approval: Approval): string {
  if (approval.approved === undefined) return "not run yet";
  if (approval.approved.length === 0) return "nothing written";
  return approval.approved.map(({ status, error }) => (error === undefined ? status : `${status}: ${error}`)).join(", ");
}

export function createAuditLog(deps: AuditLogDeps) {
  const { db } = deps;

  async function verdicts({ tenantId, repo, since, limit }: Window): Promise<Entry[]> {
    const rows = await db
      .select()
      .from(verdictRecord)
      .where(and(eq(verdictRecord.tenantId, tenantId), repo === undefined ? undefined : eq(verdictRecord.repo, repo), after(verdictRecord.verdictAt, since)))
      .orderBy(desc(verdictRecord.verdictAt))
      .limit(limit);
    return verdictEntries(rows);
  }

  /** Approval runs make no verdict, so only the workflow's runs without one are read from their run logs, at most `APPROVAL_READS` of them. */
  async function approvals({ tenantId, repo, since, limit }: Window): Promise<Entry[]> {
    const { workflowRun, workflowDefinition, tenant } = schema;
    const rows = await db
      .select({ id: workflowRun.id, anchorRunId: workflowRun.anchorRunId, createdAt: workflowRun.createdAt, domain: tenant.domain })
      .from(workflowRun)
      .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
      .innerJoin(tenant, eq(workflowRun.tenantId, tenant.id))
      .where(and(
        eq(workflowRun.tenantId, tenantId),
        eq(workflowDefinition.name, deps.workflow),
        isNotNull(workflowRun.anchorRunId),
        ne(workflowRun.id, workflowRun.anchorRunId),
        after(workflowRun.createdAt, since),
        sql`not exists (select 1 from ${verdictRecord} where ${verdictRecord.tenantId} = ${workflowRun.tenantId} and ${verdictRecord.runId} = ${workflowRun.id})`,
      ))
      .orderBy(desc(workflowRun.createdAt))
      .limit(APPROVAL_READS);
    const entries: Entry[] = [];
    for (const row of rows) {
      if (entries.length >= limit) break;
      const repoId = workflowRunRepoIdForAddress(formatRunAddress(row.anchorRunId!, row.domain));
      const approval = approvalIn(await deps.runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, row.id));
      if (!approval || (repo !== undefined && approval.repo !== repo)) continue;
      entries.push({ at: row.createdAt, actor: approval.principalId ?? UNKNOWN, action: "Approved a held Do", target: pull(approval.repo, approval.number), detail: approvalOutcome(approval) });
    }
    return entries;
  }

  async function checkVersions(tenantId: string, name: string, limit: number): Promise<Entry[]> {
    const found = await findArtifactByTitle(deps.artifacts, tenantId, checkPackName(name));
    if (!found) return [];
    const { versions } = await listArtifactVersions(deps.artifacts, found.artifactId, { limit: Math.min(limit, 100) });
    return versions.map((version) => ({
      at: new Date(version.createdAt),
      actor: version.authorId,
      action: version.version === 1 ? "Created checks" : "Changed checks",
      target: name,
      detail: `version ${version.version}`,
    }));
  }

  async function policyVersions({ tenantId, repo, limit }: Window): Promise<Entry[]> {
    const row = await db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    const repos = repo === undefined ? repoRecords(triageNs(row?.config)).map((record) => record.name) : [repo];
    return (await Promise.all(repos.map((name) => checkVersions(tenantId, name, limit)))).flat();
  }

  async function members({ tenantId, limit }: Window): Promise<Entry[]> {
    const { principal, user } = schema;
    const rows = await db
      .select({ status: principal.status, createdAt: principal.createdAt, updatedAt: principal.updatedAt, email: user.email })
      .from(principal)
      .innerJoin(user, eq(user.id, principal.refId))
      .where(and(eq(principal.tenantId, tenantId), eq(principal.kind, "user")))
      .orderBy(desc(principal.updatedAt))
      .limit(limit);
    return rows.flatMap(function memberEntries({ status, createdAt, updatedAt, email }): Entry[] {
      const added: Entry = { at: createdAt, actor: UNKNOWN, action: status === "invited" ? "Invited" : "Added to workspace", target: email, detail: "" };
      if (updatedAt.getTime() === createdAt.getTime()) return [added];
      return [added, { at: updatedAt, actor: UNKNOWN, action: "Membership changed", target: email, detail: `now ${status}` }];
    });
  }

  async function grants({ tenantId, since, limit, people }: Window): Promise<Entry[]> {
    const { grant, principal, role, user } = schema;
    const rows = await db
      .select({ grant, email: user.email, roleName: role.name })
      .from(grant)
      .leftJoin(role, eq(role.id, grant.roleId))
      .leftJoin(principal, eq(principal.id, grant.principalId))
      .leftJoin(user, and(eq(principal.kind, "user"), eq(user.id, principal.refId)))
      .where(and(eq(grant.tenantId, tenantId), after(grant.createdAt, since)))
      .orderBy(desc(grant.createdAt))
      .limit(limit);
    return rows.map(({ grant: row, email, roleName }) => ({
      at: row.createdAt,
      actor: UNKNOWN,
      action: "Granted",
      target: (people ? email : null) ?? row.principalId ?? `role ${roleName ?? row.roleId}`,
      detail: `${row.effect} ${row.action} on ${row.resource} (${row.origin})`,
    }));
  }

  /** The newest deployments; one made while the deployment before it was being replaced by the hub, from the same source, is the hub's copy. */
  async function deployments({ tenantId, limit }: Window): Promise<Entry[]> {
    const { workflowRun, workflowDefinition } = schema;
    const rows = await db
      .select({
        id: workflowRun.id,
        name: workflowDefinition.name,
        principalId: workflowRun.principalId,
        status: workflowRun.status,
        createdAt: workflowRun.createdAt,
        endedAt: workflowRun.endedAt,
        cancellationRequestedAt: workflowRun.cancellationRequestedAt,
        cancellationReason: workflowRun.cancellationReason,
        failureMessage: workflowRun.failureMessage,
      })
      .from(workflowRun)
      .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
      .where(and(eq(workflowRun.tenantId, tenantId), eq(workflowRun.id, workflowRun.anchorRunId)))
      .orderBy(desc(workflowRun.createdAt), desc(workflowRun.id))
      .limit(limit + 1);
    const entries: Entry[] = [];
    for (const [index, row] of rows.slice(0, limit).entries()) {
      const previous = rows.slice(index + 1).find((older) => older.name === row.name);
      const rotated = previous?.cancellationReason === ROTATION_REASON
        && previous.cancellationRequestedAt !== null
        && row.createdAt <= previous.cancellationRequestedAt
        && await deps.sameSource(previous.id, row.id);
      entries.push({ at: row.createdAt, actor: rotated ? HUB : row.principalId ?? UNKNOWN, action: "Deployed", target: row.name, detail: row.id });
      if (row.endedAt === null) continue;
      const byHub = row.status === "failed" || row.cancellationReason === ROTATION_REASON;
      const why = row.failureMessage ?? row.cancellationReason ?? "";
      entries.push({ at: row.endedAt, actor: byHub ? HUB : UNKNOWN, action: `Deployment ${row.status}`, target: row.name, detail: why === "" ? row.id : `${row.id} · ${why}` });
    }
    return entries;
  }

  /** Principal ids as their people's emails, where they are people. */
  async function named(tenantId: string, entries: Entry[]): Promise<Entry[]> {
    const ids = [...new Set(entries.map((entry) => entry.actor).filter((actor) => actor.startsWith("prn_")))];
    if (ids.length === 0) return entries;
    const { principal, user } = schema;
    const rows = await db
      .select({ id: principal.id, email: user.email })
      .from(principal)
      .innerJoin(user, eq(user.id, principal.refId))
      .where(and(eq(principal.tenantId, tenantId), eq(principal.kind, "user"), inArray(principal.id, ids)));
    const emails = new Map(rows.map((row) => [row.id, row.email]));
    return entries.map((entry) => ({ ...entry, actor: emails.get(entry.actor) ?? entry.actor }));
  }

  /** The workspace-wide sources the caller may read, each needing read on its stock resource. */
  async function workspaceSources(window: Window, principalId: string): Promise<Array<Promise<Entry[]>>> {
    const { tenantId } = window;
    const [grantsRead, deploymentsRead] = await Promise.all([deps.authorize(principalId, tenantId, "grant:*", "read"), deps.authorize(principalId, tenantId, "workflow:*", "read")]);
    return [
      ...(window.people ? [members(window)] : []),
      ...(grantsRead ? [grants(window)] : []),
      ...(deploymentsRead ? [deployments(window)] : []),
    ];
  }

  return async function handle(req: Request, { tenantId, principalId }: Member): Promise<Response> {
    const query = AuditQuery(Object.fromEntries(new URL(req.url).searchParams));
    if (query instanceof type.errors) return failure(400, "invalid_request", query.summary);
    const people = await deps.authorize(principalId, tenantId, "principal:*", "read");
    const window: Window = { tenantId, people, limit: query.limit ?? DEFAULT_LIMIT, ...(query.repo !== undefined && { repo: query.repo }), ...(query.since !== undefined && { since: query.since }) };
    const sources = [verdicts(window), approvals(window), policyVersions(window), ...(query.repo === undefined ? await workspaceSources(window, principalId) : [])];
    const merged = (await Promise.all(sources))
      .flat()
      .filter((entry) => query.since === undefined || entry.at >= query.since)
      .toSorted((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, window.limit);
    const shown = people ? await named(tenantId, merged) : merged;
    return Response.json({ entries: shown.map(({ at, ...entry }) => ({ time: at.toISOString(), ...entry })) } satisfies AuditLog);
  };
}
