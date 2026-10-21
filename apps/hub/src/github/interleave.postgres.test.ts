// Requires PostgreSQL at TEST_DB. A maintainer's request or a webhook and a
// reconcile pass over the same head, interleaved on one store.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { runArtifactMigrations } from "@corbits/artifacts";
import type { CheckRun } from "@corbits/github-reads";
import { emptyPack, repoPolicy, type CheckPack, type PrTriageRow, type TriageEvent } from "@corbits/triage-contracts";
import { createCoalescer, type CoalescedEvent } from "./coalescer.js";
import { createGithubPrTriage } from "./pr-triage.js";
import { DEFAULT_RECONCILE_POLICY } from "./reconcile-plan.js";
import { createTriageReconciler } from "./triage-reconciler.js";
import { createTriageStateStore, type TriageStateStore } from "./triage-state-store.js";
import type { ObservedRuns } from "./triage-runs.js";

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
  return { byRepo: new Map(), runCount: 0, verdicts: [], approved: [] };
}

function route(store: TriageStateStore, deliver: Deliver) {
  return createGithubPrTriage({
    db: stubDb(),
    cipher: { async decrypt() { return "{}"; } } as never,
    authorize: async () => true,
    pullHead: async () => "abc123",
    readCheckPack: async () => ({ status: "ok", pack: PACK, automatic: [], source: { repo: { id: "art_pack", version: 1 } } }),
    liveDeployments: async () => [DEPLOYMENT],
    observeRuns: noRuns,
    store,
    send: async ({ payload }) => deliver(payload),
    policy: DEFAULT_RECONCILE_POLICY,
    now: () => NOW,
    log: () => {},
  });
}

function reconciler(store: TriageStateStore, heads: number[], deliver: Deliver, pack: CheckPack = PACK, checks: CheckRun[] = []) {
  return createTriageReconciler({
    source: "github",
    rotationKey: "rotation",
    tenants: async () => [{ id: TENANT, domain: "tenant.example", config: CONFIG }],
    liveDeployments: async () => [DEPLOYMENT],
    latestDeployments: async () => [],
    rotation: { afterRuns: 15, redeploy: async () => ({ status: "skipped", reason: "unused" }), sameSource: async () => false, release: async () => {}, claim: async () => false, clear: async () => {} },
    openHeadsFor: async () => async () => heads.map((number) => ({ number, headSha: number === 8 ? "abc123" : `sha${number}`, updatedAt: LONG_AGO, draft: false })),
    observeTenant: async () => ({ deployments: [DEPLOYMENT], observed: [await noRuns()], workers: [] }),
    headChecks: async () => checks,
    verdicts: { latest: async () => [] },
    store,
    readCheckPack: async () => ({ status: "ok", pack, automatic: [], source: { repo: { id: "art_pack", version: 1 } } }),
    send: async ({ payload }) => deliver(payload),
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

test("PostgreSQL: a head waiting for CI that a check run and the reconciler release together starts one run, with the events it waited with", async () => {
  await withStore(async (store) => {
    const pack = { ...emptyPack(REPO), checks: { "ci-green": { enabled: true } } };
    let checks: CheckRun[] = [{ name: "build", status: "in_progress", conclusion: null }];
    const mails: unknown[] = [];
    const timers: Array<() => Promise<void>> = [];
    const coalescer = createCoalescer({
      store,
      sendMail: async ({ payload }) => { mails.push(payload); },
      headChecks: async () => checks,
      openHeadFor: async () => async () => ({ headSha: "abc123", draft: false }),
      window: { quietMs: 30_000, maxWaitMs: 120_000, burstMs: 3_000 },
      ciWait: DEFAULT_RECONCILE_POLICY,
      setTimer(fire) {
        timers.push(fire);
        return () => {};
      },
      now: () => NOW,
      log: () => {},
    });
    function webhook(event: TriageEvent, name: string, action: string): CoalescedEvent {
      const mail = { kind: "pr" as const, repo: REPO, prNumber: 8, deliveryId: event, event: name, action, headSha: "abc123", author: null, title: null, body: null, draft: null, review: null };
      return { tenantId: TENANT, workflow: "pr-triage", record: { name: REPO, connected: true }, policy: repoPolicy({ enabled: true }), pack, automatic: [], source: { repo: { id: "art_pack", version: 1 } }, mail, number: 8, headSha: "abc123", event };
    }
    async function flush() {
      await Promise.all(timers.splice(0).map((fire) => fire()));
    }
    await store.save(TENANT, REPO, [], (await store.load(TENANT, REPO)).version);

    await coalescer.accept(webhook("opened", "pull_request", "opened"));
    await flush();
    expect(mails).toEqual([]);
    expect((await store.load(TENANT, REPO)).rows).toEqual([expect.objectContaining({ status: "waiting", events: ["opened"] })]);

    checks = [{ name: "build", status: "completed", conclusion: "success" }];
    await reconciler(store, [8], async (payload) => {
      mails.push(payload);
      await coalescer.accept(webhook("checks", "check_run", "completed"));
    }, pack, checks)();
    await flush();
    expect(mailsFor8(mails)).toBe(1);
    expect(mails[0]).toMatchObject({ prNumber: 8, headSha: "abc123", events: ["opened"] });
    expect((await store.load(TENANT, REPO)).rows.map((row) => `${row.number}:${row.status}`)).toEqual(["8:queued"]);
  });
}, 120_000);
