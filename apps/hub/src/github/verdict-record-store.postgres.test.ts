// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createDB, runMigrations, schema, type DB } from "@intx/db";
import type { RepoSource, VerdictDetail } from "@corbits/triage-contracts";
import { migrateTriageTables } from "../triage-db.js";
import { recordApproved, replaceVerdict, verdictRecord, type RecordedVerdict } from "./verdict-record-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_effect_host";
const REPO = "acme/widgets";
const HEAD = "abc";
const AT = new Date("2026-10-01T00:00:00Z");
const EFFECTS = ["bb", "gh", "plain"] as const;

function held(effectId: string, status?: string) {
  return { effectId, list: "pass" as const, kind: "comment", held: true, ...(status !== undefined && { status }) };
}

function detail(statuses: Partial<Record<(typeof EFFECTS)[number], string>> = {}): VerdictDetail {
  return { actions: EFFECTS.map((effectId) => held(effectId, statuses[effectId])) };
}

function recorded(runId: string, actions: VerdictDetail): RecordedVerdict {
  return {
    runId, repo: REPO, number: 7, headSha: HEAD, startedAt: AT, verdictAt: AT, settled: true,
    state: "ready", actor: "author", humanGated: false, degraded: null, checks: [], dos: [], commented: false,
    detail: actions, runStatus: "completed",
  };
}

async function statusOf(db: DB["db"], runId: string, effectId: string): Promise<string | undefined> {
  const [row] = await db.select({ detail: verdictRecord.detail }).from(verdictRecord).where(and(eq(verdictRecord.tenantId, TENANT), eq(verdictRecord.runId, runId)));
  return row?.detail?.actions?.find((action) => action.effectId === effectId)?.status;
}

test("PostgreSQL: approving a Do on one host does not mark the other host's verdict done, and a replaced verdict keeps only its host's writes", async () => {
  const database = `corbits_effect_host_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await migrateTriageTables(db, "public");
    await db.insert(schema.tenant).values({ id: TENANT, name: "Effect host", slug: "effect-host", domain: "effect-host.test" });
    await db.insert(schema.workflowDefinition).values([
      { id: "wfd_gh", tenantId: TENANT, name: "pr-triage", status: "stopped" },
      { id: "wfd_bb", tenantId: TENANT, name: "pr-triage-bitbucket-datacenter", status: "stopped" },
    ]);
    await db.insert(schema.workflowRun).values([
      { id: "run_gh", definitionId: "wfd_gh", anchorRunId: "run_gh", tenantId: TENANT, status: "completed" },
      { id: "run_bb", definitionId: "wfd_bb", anchorRunId: "run_bb", tenantId: TENANT, status: "completed" },
    ]);
    // The same effect ids, as written before the host was part of the hash.
    await replaceVerdict(db, TENANT, recorded("run_gh", detail()));
    await replaceVerdict(db, TENANT, recorded("run_bb", detail()));

    await recordApproved(db, TENANT, [
      { repo: REPO, number: 7, effectId: "bb", status: "done", source: "bitbucket-datacenter" },
      { repo: REPO, number: 7, effectId: "gh", status: "done", source: "github" satisfies RepoSource },
      { repo: REPO, number: 7, effectId: "plain", status: "done" },
    ]);
    expect(await statusOf(db, "run_bb", "bb")).toBe("done");
    expect(await statusOf(db, "run_gh", "bb")).toBeUndefined();
    expect(await statusOf(db, "run_gh", "gh")).toBe("done");
    expect(await statusOf(db, "run_gh", "plain")).toBe("done");
    expect(await statusOf(db, "run_bb", "gh")).toBeUndefined();
    expect(await statusOf(db, "run_bb", "plain")).toBeUndefined();

    await replaceVerdict(db, TENANT, recorded("run_bb", detail()));
    expect(await statusOf(db, "run_bb", "bb")).toBe("done");
    expect(await statusOf(db, "run_bb", "gh")).toBeUndefined();
    expect(await statusOf(db, "run_bb", "plain")).toBeUndefined();

    await replaceVerdict(db, TENANT, recorded("run_gh", detail()));
    expect(await statusOf(db, "run_gh", "gh")).toBe("done");
    expect(await statusOf(db, "run_gh", "plain")).toBe("done");
    expect(await statusOf(db, "run_gh", "bb")).toBeUndefined();
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
