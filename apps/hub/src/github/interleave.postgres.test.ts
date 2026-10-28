// Requires PostgreSQL at TEST_DB. A maintainer's request or a webhook and a
// reconcile pass over the same head, interleaved on one store.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { runArtifactMigrations } from "@corbits/artifacts";
import type { CheckRun } from "@corbits/github-reads";
import { emptyPack, type CheckPack, type PrTriageRow } from "@corbits/triage-contracts";
import { createBacklogStart } from "./backlog-triage.js";
import { ListenerUnroutedError } from "./deployment.js";
import { createGithubPrTriage } from "./pr-triage.js";
import { DEFAULT_RECONCILE_POLICY } from "./reconcile-plan.js";
import { failDelivery, queueHead } from "./triage-queue.js";
import { createTriageReconciler, createUnroutedTries } from "./triage-reconciler.js";
import { createTriageStateStore, type TriageStateStore } from "./triage-state-store.js";
import type { ObservedRuns } from "./manager-runs.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_state";
const REPO = "acme/widgets";
const NOW = new Date("2026-10-08T12:00:00Z");
const LONG_AGO = "2026-10-07T00:00:00.000Z";
const PACK = { ...emptyPack(REPO), checks: { "no-merge-conflicts": { enabled: true } } };
const CONFIG = { corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true, installationId: 1 }] } };
const DEPLOYMENT = { runId: "anchor-1", address: "anchor-1@tenant.example", createdAt: NOW, cancelling: false };
const FAILED: PrTriageRow = { number: 8, headSha: "abc123", status: "failed", attempts: 1, error: "run failed", firstSeenAt: LONG_AGO, queuedAt: LONG_AGO, updatedAt: LONG_AGO };

type Deliver = (payload: unknown) => Promise<void>;

function stubDb() {
  return {
    query: {
      credential: { async findFirst() { return { id: "crd", secret: "sealed", status: "active", principalId: null }; } },
      tenant: { async findFirst() { return { domain: "tenant.example", config: CONFIG }; } },
    },
  } as never;
}

async function noRuns(): Promise<ObservedRuns> {
  return { byRepo: new Map() };
}

function route(store: TriageStateStore, deliver: Deliver) {
  return createGithubPrTriage({
    db: stubDb(),
    cipher: { async decrypt() { return "{}"; } } as never,
    onKeyMoved: noKeyPush,
    authorize: async () => true,
    pullHead: async () => "abc123",
    readCheckPack: async () => ({ status: "ok", pack: PACK, automatic: [], source: { file: { path: ".corbits-triage.yml", sha: "art_pack-1" } } }),
    listener: async () => DEPLOYMENT,
    managerRuns: noRuns,
    store,
    send: async ({ payload }) => deliver(payload),
    retry() {},
    policy: DEFAULT_RECONCILE_POLICY,
    now: () => NOW,
    log: () => {},
  });
}

function reconciler(store: TriageStateStore, heads: number[], deliver: Deliver, pack: CheckPack = PACK, checks: CheckRun[] = [], updatedAt = LONG_AGO) {
  return createTriageReconciler({
    source: "github",
    tenants: async () => [{ id: TENANT, domain: "tenant.example", config: CONFIG }],
    listener: async () => DEPLOYMENT,
    openHeadsFor: async () => async () => heads.map((number) => ({ number, headSha: number === 8 ? "abc123" : `sha${number}`, updatedAt, draft: false })),
    activity: { stale: () => true },
    managerRuns: noRuns,
    headChecks: async () => checks,
    verdicts: { latest: async () => [] },
    store,
    readCheckPack: async () => ({ status: "ok", pack, automatic: [], source: { file: { path: ".corbits-triage.yml", sha: "art_pack-1" } } }),
    send: async ({ payload }) => deliver(payload),
    unroutedTries: createUnroutedTries(),
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

/** The route mails one head as `prNumber`; the reconciler mails its heads as `items`. */
function mailsFor8(payloads: unknown[]): number {
  return payloads.filter(function names8(payload) {
    const mail = payload as { prNumber?: number; items?: Array<{ prNumber: number }> };
    return mail.prNumber === 8 || mail.items?.some((item) => item.prNumber === 8) === true;
  }).length;
}

test("PostgreSQL: a click while the reconciler is mailing the same head starts one run, not two", async () => {
  await withStore(async (store) => {
    const mails: unknown[] = [];
    let routeStatus = 0;
    const handle = route(store, async (payload) => { mails.push(payload); });
    await reconciler(store, [8], async (payload) => {
      mails.push(payload);
      routeStatus = (await handle({ repo: REPO, number: 8 }, { tenantId: TENANT, principalId: "member-1" })).status;
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
    const res1 = await handle({ repo: REPO, number: 8 }, { tenantId: TENANT, principalId: "member-1" });
    expect(res1.status).toBe(502);
    expect(await res1.json()).toEqual({ error: { code: "hub_unavailable", message: `Could not queue ${REPO}#8: mail down. Try again.` } });
    const rows = (await store.load(TENANT, REPO)).rows;
    expect(rows.find((row) => row.number === 8)).toEqual(FAILED);
    expect(rows.find((row) => row.number === 9)?.status).toBe("queued");
    expect((await handle({ repo: REPO, number: 8 }, { tenantId: TENANT, principalId: "member-1" })).status).toBe(202);
  });
}, 120_000);

test("PostgreSQL: a backlog started while the listener is starting answers 202, and its open heads are queued and mailed once the listener is up", async () => {
  await withStore(async (store) => {
    let kicked = 0;
    const start = createBacklogStart({
      readCheckPack: async () => ({ status: "ok", pack: PACK, automatic: [], source: { file: { path: ".corbits-triage.yml", sha: "art_pack-1" } } }),
      async sendMail() {
        throw new ListenerUnroutedError("github", DEPLOYMENT.address);
      },
      openHeads: async () => [{ number: 8, headSha: "abc123", draft: false }, { number: 10, headSha: "sha10", draft: false }, { number: 11, headSha: "sha11", draft: true }],
      store,
      policy: DEFAULT_RECONCILE_POLICY,
      now: () => NOW,
      retry() {
        kicked += 1;
      },
      log: () => {},
    });
    const res = await start(TENANT, { name: REPO, connected: true, enabled: true });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 202, body: { status: "started" } });
    expect(kicked).toBe(1);
    expect((await store.load(TENANT, REPO)).rows.map((row) => `${row.number}:${row.status}:${row.unrouted === true}`)).toEqual(["8:failed:true", "10:failed:true"]);

    const mails: Array<{ items?: Array<{ prNumber: number }> }> = [];
    await reconciler(store, [8, 10], async (payload) => {
      mails.push(payload as never);
    })();
    expect(mails.flatMap((mail) => mail.items?.map((item) => item.prNumber) ?? [])).toEqual([8, 10]);
    expect((await store.load(TENANT, REPO)).rows.map((row) => `${row.number}:${row.status}`)).toEqual(["8:queued", "10:queued"]);
  });
}, 120_000);

test("PostgreSQL: a maintainer's triage request while the listener is starting answers 202 and the head is mailed once the listener is up", async () => {
  await withStore(async (store) => {
    const handle = route(store, async () => {
      throw new ListenerUnroutedError("github", DEPLOYMENT.address);
    });
    const res = await handle({ repo: REPO, number: 8 }, { tenantId: TENANT, principalId: "member-1" });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 202, body: { status: "queued", headSha: "abc123" } });
    expect((await store.load(TENANT, REPO)).rows.map((row) => `${row.number}:${row.status}:${row.unrouted === true}`)).toEqual(["8:failed:true"]);

    const mails: unknown[] = [];
    await reconciler(store, [8], async (payload) => {
      mails.push(payload);
    })();
    expect(mailsFor8(mails)).toBe(1);
  });
}, 120_000);

test("PostgreSQL: a webhook's head queued while a reconcile pass plans over it, whose mail then reaches no listener, goes out on the next pass", async () => {
  await withStore(async (store) => {
    const opened = { tenantId: TENANT, repo: REPO, number: 9, headSha: "sha9" };
    let interleaved = false;
    const racing: TriageStateStore = {
      load: (tenantId, repo) => store.load(tenantId, repo),
      async save(tenantId, repo, rows, expected) {
        if (!interleaved) {
          interleaved = true;
          await queueHead(store, opened, new Date(NOW.getTime() - 5), () => false);
        }
        return store.save(tenantId, repo, rows, expected);
      },
    };
    await reconciler(racing, [8, 9], async () => {}, PACK, [], NOW.toISOString())();
    await failDelivery(store, opened, new ListenerUnroutedError("github", DEPLOYMENT.address), NOW);

    const mails: Array<{ items?: Array<{ prNumber: number }> }> = [];
    await reconciler(store, [8, 9], async (payload) => {
      mails.push(payload as never);
    }, PACK, [], NOW.toISOString())();
    expect(mails.flatMap((mail) => mail.items?.map((item) => item.prNumber) ?? [])).toContain(9);
  });
}, 120_000);
