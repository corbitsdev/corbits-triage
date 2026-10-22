// Requires PostgreSQL at TEST_DB. The hub's run trigger through stock's
// materializer: a deployment declaring TRIAGE_MAIL_ACCEPT admits its tenant's
// system sender and refuses another tenant's.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createGrantStore, createPrincipalKeyStore, createWorkflowRunLaunchSpecStore, resolveSenderPrincipal, runMigrations, schema, type DB } from "@intx/db";
import { createMailTriggeredRunGrantsMaterializer, HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { collectMailAcceptGrants } from "@intx/workflow-deploy";
import { createTenantSystemSender } from "@corbits/webhooks";
import { TRIAGE_MAIL_ACCEPT, TRIAGE_MAIL_SENDER } from "@corbits/triage-contracts";
import { SenderRefusedError, systemSenderMaterializer } from "./deployment.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_gate";
const OTHER = "tnt_other";
const ADDRESS = "run_listener@gate.test";
const BUNDLE = {
  source: { kind: "asset", assetId: "ast_triage", package: { format: "source", commitSha: "c0ffee", packageName: "@corbits/pr-triage-workflow" } },
  entry: "./pr-triage-github.mjs",
  projection: { id: "pr-triage-github", stepOrder: ["events"], steps: { events: { kind: "step", id: "events" } }, triggers: [] },
  closure: { schemaVersion: "1", topLevel: [], entries: [] },
  approvedWireHash: "deadbeef",
  approvedGrants: [],
};

async function withDatabase(body: (db: DB["db"]) => Promise<void>): Promise<void> {
  const database = `corbits_gate_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await body(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

test("PostgreSQL: a deployment declaring the triage accept rule takes its tenant's system sender's trigger and refuses another tenant's", async () => {
  await withDatabase(async function gate(db) {
    const principalKeyStore = createPrincipalKeyStore({ db, cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)) });
    await db.insert(schema.tenant).values([{ id: TENANT, name: "Gate", slug: "gate", domain: "gate.test", config: {} }, { id: OTHER, name: "Other", slug: "other", domain: "other.test", config: {} }]);
    await db.insert(schema.principal).values({ id: "prn_deployer", tenantId: TENANT, kind: "user", refId: "deployer", status: "active" });
    await db.insert(schema.asset).values({ id: "ast_triage", tenantId: TENANT, kind: "workflow", name: "pr-triage-github", creatorPrincipalId: "prn_deployer" });
    await db.insert(schema.workflowDefinition).values({ id: "wfd_triage", tenantId: TENANT, name: "pr-triage-github", assetId: "ast_triage" });
    await db.insert(schema.workflowRun).values({ id: "run_listener", anchorRunId: "run_listener", definitionId: "wfd_triage", tenantId: TENANT, address: ADDRESS, status: "running", publicKey: "listener-key" });
    await createWorkflowRunLaunchSpecStore(db).create({
      anchorRunId: "run_listener",
      sessionId: "ses_listener",
      deploymentDomain: "gate.test",
      sourceAuthorityPrincipalId: "prn_deployer",
      frozenApprovalBundle: BUNDLE,
      grantSnapshot: { perStep: [{ stepId: "events", grants: [`mail.address:${ADDRESS}`, ...collectMailAcceptGrants({ mailAccept: TRIAGE_MAIL_ACCEPT })], grantEffects: {} }], grantRequirements: [] },
      sourceOfferingIds: ["off_a"],
      defaultSourceOfferingId: "off_a",
      deployContent: {},
    });
    const systemSender = createTenantSystemSender({ db, principalKeyStore });
    const materialize = createMailTriggeredRunGrantsMaterializer({ db, principalKeyStore, grantStore: createGrantStore(db), registry: HUB_CONDITION_REGISTRY });
    async function triggerAs(tenantId: string, domain: string) {
      await systemSender.resolve({ tenantId, domain, localPart: TRIAGE_MAIL_SENDER });
      const sender = await resolveSenderPrincipal(db, principalKeyStore, `${TRIAGE_MAIL_SENDER}@${domain}`);
      return systemSenderMaterializer(materialize, sender!)({ agentAddress: ADDRESS, runId: "run_listener" });
    }

    await expect(triggerAs(OTHER, "other.test")).rejects.toBeInstanceOf(SenderRefusedError);
    expect((await triggerAs(TENANT, "gate.test")).outcome).toBe("materialized");
  });
}, 60_000);
