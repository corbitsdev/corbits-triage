// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema, type DB } from "@intx/db";
import { createArtifact, runArtifactMigrations } from "@corbits/artifacts";
import { APPROVE_DO_KIND, AuditLog, checkPackName, emptyPack, stockTriggerMail } from "@corbits/triage-contracts";
import type { WorkflowRunEvent } from "@intx/hub-sessions";
import { createAuditLog, ROTATION_REASON } from "./audit-log.js";
import { loadCheckPack } from "./github/check-pack-store.js";
import { migrateTriageTables } from "./triage-db.js";
import { type RecordedVerdict, replaceVerdict } from "./github/verdict-record-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_audit";
const REPO = "acme/widgets";
const OWNER = "owner@acme.test";

function at(time: string): Date {
  return new Date(`2026-10-01T${time}:00Z`);
}

function approvalRun(mail: unknown): WorkflowRunEvent[] {
  return [
    { seq: 0, type: "RunStarted", body: { at: at("10:05").toISOString(), trigger: { payload: mail } } },
    { seq: 1, type: "StepCompleted", body: { stepId: "executeApproved", output: { ref: `inline:${JSON.stringify({ dos: [{ effectId: "eff_approve", status: "done" }] })}` } } },
    { seq: 2, type: "RunCompleted", body: {} },
  ];
}

const APPROVAL = { kind: APPROVE_DO_KIND, principalId: "prn_owner", request: { repo: REPO, number: 7 }, step: { effectId: "eff_approve", kind: "approve" } };
const LOGS: Record<string, WorkflowRunEvent[]> = {
  wfr_approval: approvalRun(stockTriggerMail(APPROVAL)),
  wfr_forged: approvalRun({ ...stockTriggerMail(APPROVAL), headers: { from: "mallory@elsewhere.test", to: ["pr-triage@acme.test"] } }),
};

function verdict(runId: string, time: string, state: string, comment: string, headSha = "abcdef123"): RecordedVerdict {
  return {
    runId, repo: REPO, number: 7, headSha, startedAt: at(time), verdictAt: at(time), settled: true, state, actor: "maintainer", humanGated: true,
    degraded: null, checks: [], dos: [], commented: false, runStatus: "completed",
    detail: { actions: [{ list: "fail", effectId: "eff_comment", kind: "comment", status: comment }, { list: "pass", effectId: "eff_approve", kind: "approve", held: true, status: "done" }] },
  };
}

/** Seeds verdict rows as managers record them. */
async function seed(db: DB["db"], tenantId: string, verdicts: readonly RecordedVerdict[]): Promise<void> {
  for (const verdict of verdicts) await replaceVerdict(db, tenantId, verdict);
}

function lines(log: AuditLog): string[] {
  return log.entries.map(({ actor, action, target }) => `${actor} | ${action} | ${target}`);
}

test("PostgreSQL: the audit log merges verdicts, the Dos they ran, approvals, check versions, members and deployments, newest first, as far as the caller may read", async () => {
  const database = `corbits_audit_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    await runArtifactMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await migrateTriageTables(db, "public");
    await db.insert(schema.tenant).values({ id: TENANT, name: "Audit", slug: "audit", domain: "audit.test", config: { corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true, installationId: 1 }] } } });
    await db.insert(schema.user).values([
      { id: "usr_owner", name: "Owner", email: OWNER },
      { id: "usr_dana", name: "Dana", email: "dana@acme.test" },
      { id: "usr_invitee", name: "Invitee", email: "invitee@acme.test" },
    ]);
    await db.insert(schema.principal).values([
      { id: "prn_owner", tenantId: TENANT, kind: "user", refId: "usr_owner", status: "active", createdAt: at("08:00"), updatedAt: at("08:00") },
      { id: "prn_dana", tenantId: TENANT, kind: "user", refId: "usr_dana", status: "active", createdAt: at("07:00"), updatedAt: at("10:20") },
      { id: "prn_invitee", tenantId: TENANT, kind: "user", refId: "usr_invitee", status: "invited", createdAt: at("10:10"), updatedAt: at("10:10") },
    ]);
    await db.insert(schema.workflowDefinition).values({ id: "wfd_triage", tenantId: TENANT, name: "pr-triage", status: "stopped" });
    await db.insert(schema.workflowRun).values([
      {
        id: "wfr_old", anchorRunId: "wfr_old", definitionId: "wfd_triage", tenantId: TENANT, principalId: "prn_owner", status: "cancelled", createdAt: at("06:00"),
        cancellationRequestedAt: at("09:30"), cancellationReason: ROTATION_REASON, endedAt: at("09:30"),
      },
      { id: "wfr_anchor", anchorRunId: "wfr_anchor", definitionId: "wfd_triage", tenantId: TENANT, principalId: "prn_owner", status: "running", createdAt: at("09:00") },
      { id: "wfr_verdict", anchorRunId: "wfr_anchor", definitionId: "wfd_triage", tenantId: TENANT, status: "completed", createdAt: at("09:59") },
      { id: "wfr_forged", anchorRunId: "wfr_anchor", definitionId: "wfd_triage", tenantId: TENANT, status: "completed", createdAt: at("10:04") },
      { id: "wfr_approval", anchorRunId: "wfr_anchor", definitionId: "wfd_triage", tenantId: TENANT, status: "completed", createdAt: at("10:05") },
    ]);
    await seed(db, TENANT, [verdict("wfr_verdict", "10:00", "needs-review", "done"), verdict("wfr_retriage", "10:30", "ready", "failed", "fedcba321")]);
    await db.transaction(async function seedPack(tx) {
      await createArtifact(tx, {
        scope: { tenantId: TENANT, principalId: "prn_owner" }, ownerPrincipalId: "prn_owner", kind: "document",
        title: checkPackName(REPO, "github"), content: JSON.stringify(emptyPack(REPO)), source: { origin: "user" },
      });
    });

    const read: string[] = [];
    function auditFor(denied: ReadonlySet<string>) {
      return createAuditLog({
        db,
        artifacts: db,
        readCheckPack(tenantId, repo, source) {
          return loadCheckPack({ db, artifacts: db, async automaticKinds() { return []; }, log() {} }, tenantId, repo, source);
        },
        workflows: ["pr-triage"],
        runReader: {
          async readRunEvents(_repoId, _ref, runId) {
            read.push(runId);
            return LOGS[runId] ?? [];
          },
        },
        async authorize(_principalId, _tenantId, resource) {
          return !denied.has(resource);
        },
      });
    }
    async function log(audit: ReturnType<typeof createAuditLog>, query = ""): Promise<AuditLog> {
      return AuditLog.assert(await (await audit(new Request(`http://hub.test/api/integrations/audit/${TENANT}${query}`), { tenantId: TENANT, principalId: "prn_owner" })).json());
    }

    const audit = auditFor(new Set());
    expect(lines(await log(audit))).toEqual([
      `${OWNER} | Created checks | ${REPO}`,
      `Triage | Triaged | ${REPO}#7`,
      `Triage | Failed comment | ${REPO}#7`,
      "unknown | Membership changed | dana@acme.test",
      "unknown | Invited | invitee@acme.test",
      `${OWNER} | Approved a held Do | ${REPO}#7`,
      `Triage | Triaged | ${REPO}#7`,
      "hub | Deployment cancelled | pr-triage",
      "hub | Deployed | pr-triage",
      `unknown | Added to workspace | ${OWNER}`,
      "unknown | Added to workspace | dana@acme.test",
      `${OWNER} | Deployed | pr-triage`,
    ]);
    expect(read.toSorted()).toEqual(["wfr_approval", "wfr_forged"]);

    expect(lines(await log(audit, "?since=2026-10-01T10:05:00Z"))).toEqual([
      `${OWNER} | Created checks | ${REPO}`,
      `Triage | Triaged | ${REPO}#7`,
      `Triage | Failed comment | ${REPO}#7`,
      "unknown | Membership changed | dana@acme.test",
      "unknown | Invited | invitee@acme.test",
      `${OWNER} | Approved a held Do | ${REPO}#7`,
    ]);
    const windowed = (await log(audit, `?repo=${REPO}&since=2026-10-01T10:05:00Z`)).entries;
    expect(windowed.map((entry) => entry.action)).toEqual(["Created checks", "Triaged", "Failed comment", "Approved a held Do"]);
    expect(windowed.find((entry) => entry.action === "Failed comment")?.detail).toBe("on fail");

    expect(lines(await log(auditFor(new Set(["principal:*", "workflow:*"])), "?since=2026-10-01T10:05:00Z"))).toEqual([
      `prn_owner | Created checks | ${REPO}`,
      `Triage | Triaged | ${REPO}#7`,
      `Triage | Failed comment | ${REPO}#7`,
      `prn_owner | Approved a held Do | ${REPO}#7`,
    ]);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
