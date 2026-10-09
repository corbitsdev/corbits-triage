// Requires PostgreSQL at TEST_DB. A maintainer's request and a reconcile
// pass over the same head, interleaved on one store.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { runArtifactMigrations } from "@corbits/artifacts";
import { checkPackName, type CheckPack, type PrTriageRow } from "@corbits/triage-contracts";
import { createGithubPrTriage } from "./pr-triage.js";
import { DEFAULT_RECONCILE_POLICY } from "./reconcile-plan.js";
import { createTriageReconciler } from "./triage-reconciler.js";
import { createTriageStateStore, type TriageStateStore } from "./triage-state-store.js";
import type { ObservedRuns } from "./triage-runs.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_state";
const REPO = "acme/widgets";
const PORTAL = "https://portal.example";
const NOW = new Date("2026-10-08T12:00:00Z");
const LONG_AGO = "2026-10-07T00:00:00.000Z";
const PACK = { name: checkPackName(REPO), schemaVersion: 1, repo: REPO, checks: [] } as unknown as CheckPack;
const CONFIG = { corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true, installationId: 1 }] } };
const DEPLOYMENT = { runId: "anchor-1", address: "anchor-1@tenant.example" };
const FAILED: PrTriageRow = { number: 8, headSha: "abc123", status: "failed", attempts: 1, error: "run failed", firstSeenAt: LONG_AGO, queuedAt: LONG_AGO, updatedAt: LONG_AGO };

type Deliver = (payload: unknown) => Promise<void>;

function stubDb() {
  return {
    query: {
      principal: { async findFirst() { return { id: "member-1" }; } },
      credential: { async findFirst() { return { id: "crd", secret: "sealed" }; } },
      tenant: { async findFirst() { return { domain: "tenant.example", config: CONFIG }; } },
    },
  } as never;
}

function request(): Request {
  return new Request(`https://hub.example/api/integrations/github-triage/${TENANT}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: PORTAL, "sec-fetch-site": "same-site" },
    body: JSON.stringify({ repo: REPO, number: 8 }),
  });
}

async function noRuns(): Promise<ObservedRuns> {
  return { byRepo: new Map() };
}

function route(store: TriageStateStore, deliver: Deliver) {
  return createGithubPrTriage({
    db: stubDb(),
    cipher: { async decrypt() { return "{}"; } } as never,
    getSession: async () => ({ user: { id: "user-1" } }),
    authorize: async () => true,
    trustedPortalOrigins: [PORTAL],
    pullHead: async () => "abc123",
    readCheckPack: async () => ({ status: "ok", pack: PACK }),
    liveDeployment: async () => DEPLOYMENT,
    observeRuns: noRuns,
    store,
    deliver: async (_tenant, _address, payload) => deliver(payload),
    policy: DEFAULT_RECONCILE_POLICY,
    now: () => NOW,
    log: () => {},
  });
}

function reconciler(store: TriageStateStore, heads: number[], deliver: Deliver) {
  return createTriageReconciler({
    tenants: async () => [{ id: TENANT, domain: "tenant.example", config: CONFIG }],
    liveDeployment: async () => DEPLOYMENT,
    openHeadsFor: async () => async () => heads.map((number) => ({ number, headSha: number === 8 ? "abc123" : `sha${number}`, updatedAt: LONG_AGO })),
    observeRuns: noRuns,
    store,
    readCheckPack: async () => ({ status: "ok", pack: PACK }),
    deliver: async (_tenant, _address, payload) => deliver(payload),
    policy: DEFAULT_RECONCILE_POLICY,
    now: () => NOW,
    log: () => {},
  });
}

async function withStore(body: (store: TriageStateStore) => Promise<void>): Promise<void> {
  const database = `corbits_interleave_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    await runArtifactMigrations(config, { schema: "public" });
    handle = createDB(config);
    await handle.db.insert(schema.tenant).values({ id: TENANT, name: "State", slug: "state", domain: "state.test" });
    await handle.db.insert(schema.principal).values({ id: "prn_github", tenantId: TENANT, kind: "user", refId: "github", status: "active" });
    const store = createTriageStateStore({ db: handle.db, writerFor: async () => "prn_github", log: () => {} });
    await store.save(TENANT, REPO, [FAILED], null);
    await body(store);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

function mailsFor8(payloads: unknown[]): number {
  return payloads.filter((payload) => (payload as { prNumber?: number }).prNumber === 8).length;
}

test("PostgreSQL: a click while the reconciler is mailing the same head starts one run, not two", async () => {
  await withStore(async (store) => {
    const mails: unknown[] = [];
    let routeStatus = 0;
    const handle = route(store, async (payload) => { mails.push(payload); });
    await reconciler(store, [8], async (payload) => {
      mails.push(payload);
      routeStatus = (await handle(request(), TENANT)).status;
    })();
    expect(routeStatus).toBe(409);
    expect(mailsFor8(mails)).toBe(1);
    expect((await store.load(TENANT, REPO)).rows.map((row) => `${row.number}:${row.status}`)).toEqual(["8:queued"]);
  });
}, 120_000);

test("PostgreSQL: a failed mail whose first restore is refused still puts the head back, so the maintainer's retry is accepted", async () => {
  await withStore(async (store) => {
    let first = true;
    const handle = route(store, async () => {
      if (!first) return;
      first = false;
      await reconciler(store, [8, 9], async () => {})();
      throw new Error("mail down");
    });
    const res1 = await handle(request(), TENANT);
    expect(res1.status).toBe(502);
    expect(await res1.json()).toEqual({ error: { code: "hub_unavailable", message: `Could not queue ${REPO}#8: mail down. Try again.` } });
    const rows = (await store.load(TENANT, REPO)).rows;
    expect(rows.find((row) => row.number === 8)).toEqual(FAILED);
    expect(rows.find((row) => row.number === 9)?.status).toBe("queued");
    expect((await handle(request(), TENANT)).status).toBe(202);
  });
}, 120_000);
