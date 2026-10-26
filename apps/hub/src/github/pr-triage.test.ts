import { describe, expect, test } from "bun:test";
import { checkPackName, emptyPack, type PrTriageRow } from "@corbits/triage-contracts";
import { GithubRateLimited } from "./github-usage.js";
import { createGithubPrTriage, type GithubPrTriageDeps } from "./pr-triage.js";
import { DEFAULT_RECONCILE_POLICY, planTenant, type ObservedRun } from "./reconcile-plan.js";
import { TriageStateConflictError, type TriageStateVersion } from "./triage-state-store.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const TENANT_ID = "tenant-1";
const MEMBER = { tenantId: TENANT_ID, principalId: "member-1" };
const REPO = "acme/widgets";
const CREDENTIAL_ID = "crd_github";
const NOW = new Date("2026-10-08T12:00:00Z");
const PACK = { ...emptyPack(REPO), checks: { "no-merge-conflicts": { enabled: true } } };
const ENABLED = { name: REPO, connected: true, enabled: true };
const ANCHOR = { runId: "anchor-1", address: "anchor-1@tenant.example", createdAt: NOW, cancelling: false };

type Delivered = { payload: unknown };
type Stub = { delivered: Delivered[]; saved: PrTriageRow[][]; authorized: unknown[][] };

function stubDb(repo: Record<string, unknown>) {
  return {
    query: {
      credential: { async findFirst() { return { id: CREDENTIAL_ID, secret: "sealed", status: "active", principalId: null }; } },
      tenant: { async findFirst() { return { domain: "tenant.example", config: { corbitsTriage: { repos: [repo] } } }; } },
    },
  } as never;
}

function observed(runs: ObservedRun[]): GithubPrTriageDeps["observeRuns"] {
  return async function observeRuns() {
    return { byRepo: new Map([[REPO, new Map([["8@abc123", runs]])]]), runCount: runs.length, verdicts: [], approved: [] };
  };
}

const VERSION: TriageStateVersion = { artifactId: "art_state", version: 1 };

/** Rows that move with each save, so a reload sees the last write; `refuse` makes that many saves throw as stale first. */
function stored(rows: PrTriageRow[], saved: PrTriageRow[][], refuse = 0): GithubPrTriageDeps["store"] {
  let current = rows;
  let refusals = refuse;
  return {
    async load() {
      return { rows: current, version: VERSION };
    },
    async save(_tenant, _repo, next) {
      if (refusals > 0) {
        refusals -= 1;
        throw new TriageStateConflictError(REPO);
      }
      current = next;
      saved.push(next);
      return VERSION;
    },
  };
}

function stub(): Stub {
  return { delivered: [], saved: [], authorized: [] };
}

function handler(repo: Record<string, unknown>, s: Stub, overrides: Partial<GithubPrTriageDeps> = {}) {
  return createGithubPrTriage({
    db: stubDb(repo),
    cipher: { async decrypt() { return "{}"; } } as never,
    onKeyMoved: noKeyPush,
    authorize: async (...args) => {
      s.authorized.push(args);
      return true;
    },
    pullHead: async (_tenantId, _record, number) => (number === 8 ? "abc123" : undefined),
    readCheckPack: async () => ({ status: "ok", pack: PACK, automatic: [], source: { repo: { id: "art_pack", version: 1 } } }),
    liveDeployments: async () => [ANCHOR],
    listener: async () => undefined,
    observeRuns: observed([]),
    managerRuns: async () => ({ byRepo: new Map(), runCount: 0, verdicts: [], approved: [] }),
    store: stored([], s.saved),
    send: async ({ payload }) => {
      s.delivered.push({ payload });
    },
    policy: DEFAULT_RECONCILE_POLICY,
    now: () => NOW,
    log: () => {},
    ...overrides,
  });
}

function request(number = 8) {
  return { repo: REPO, number };
}

async function refused(res: Response, status: number, code: string, details?: Record<string, string>): Promise<void> {
  expect(res.status).toBe(status);
  expect(await res.json()).toMatchObject({ error: { code, ...details } });
}

function queuedRow(agoMs: number): PrTriageRow {
  const at = new Date(NOW.getTime() - agoMs).toISOString();
  return { number: 8, headSha: "abc123", status: "queued", attempts: 2, firstSeenAt: at, queuedAt: at, updatedAt: at };
}

describe("createGithubPrTriage", () => {
  test("sends the bridge's payload and remembers the head as queued", async () => {
    const s = stub();
    const res = await handler(ENABLED, s)(request(), MEMBER);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued", headSha: "abc123" });
    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0]!.payload).toMatchObject({
      kind: "pr",
      repo: REPO,
      prNumber: 8,
      headSha: "abc123",
      policy: { enabled: true, checkPack: { name: checkPackName(REPO, "github") } },
    });
    expect((s.delivered[0]!.payload as { pack: unknown }).pack).toEqual(PACK);
    const at = NOW.toISOString();
    expect(s.saved).toEqual([[{ number: 8, headSha: "abc123", status: "queued", attempts: 0, firstSeenAt: at, queuedAt: at, updatedAt: at }]]);
  });

  test("a member denied use of the GitHub App credential gets 403 and nothing is mailed", async () => {
    const s = stub();
    const authorize: GithubPrTriageDeps["authorize"] = async (...args) => {
      s.authorized.push(args);
      return false;
    };
    await refused(await handler(ENABLED, s, { authorize })(request(), MEMBER), 403, "forbidden");
    expect(s.authorized).toEqual([["member-1", TENANT_ID, `credential:${CREDENTIAL_ID}`, "use"]]);
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  test("refuses a repository whose triage is disabled and mails nothing", async () => {
    const s = stub();
    await refused(await handler({ ...ENABLED, enabled: false }, s)(request(), MEMBER), 409, "repo_not_enabled");
    expect(s.delivered).toEqual([]);
  });

  test("takes only the GitHub record of the name, so a Bitbucket repository of that name is not triaged", async () => {
    const s = stub();
    await refused(await handler({ ...ENABLED, source: "bitbucket-datacenter" }, s)(request(), MEMBER), 409, "repo_not_connected");
    expect(s.delivered).toEqual([]);
  });

  test("refuses a repository whose check pack is missing or unreadable, each by name", async () => {
    const s = stub();
    await refused(await handler(ENABLED, s, { readCheckPack: async () => ({ status: "missing" }) })(request(), MEMBER), 409, "needs_setup");
    await refused(await handler(ENABLED, s, { readCheckPack: async () => ({ status: "corrupt", reason: "repo must be owner/name.", repo: { id: "art_pack", version: 1 }, automatic: [] }) })(request(), MEMBER), 409, "check_pack_unreadable", { reason: "repo must be owner/name." });
    expect(s.delivered).toEqual([]);
  });

  test("refuses a pull request that is not open", async () => {
    const s = stub();
    await refused(await handler(ENABLED, s)(request(9), MEMBER), 409, "pull_request_not_open");
    expect(s.delivered).toEqual([]);
  });

  test("refuses a head whose run is still going, but not one that is stuck", async () => {
    const live: ObservedRun = { runId: "run-live", source: "github", status: "running", startedAt: new Date(NOW.getTime() - 60_000).toISOString() };
    const stuck: ObservedRun = { runId: "run-stuck", source: "github", status: "running", startedAt: new Date(NOW.getTime() - 2 * DEFAULT_RECONCILE_POLICY.stuckAfterMs).toISOString() };
    const s = stub();
    await refused(await handler(ENABLED, s, { observeRuns: observed([live]) })(request(), MEMBER), 409, "already_running");
    expect(s.delivered).toEqual([]);
    expect((await handler(ENABLED, s, { observeRuns: observed([stuck]) })(request(), MEMBER)).status).toBe(202);
    expect(s.delivered).toHaveLength(1);
  });

  test("with the host's listener live, mails with no pr-triage deployment and refuses a pull request whose manager is up", async () => {
    const s = stub();
    const listening: Partial<GithubPrTriageDeps> = { listener: async () => ({ ...ANCHOR, runId: "listener-1", address: "listener-1@tenant.example" }), liveDeployments: async () => [] };
    expect((await handler(ENABLED, s, listening)(request(), MEMBER)).status).toBe(202);
    expect(s.delivered).toHaveLength(1);
    const managed = stub();
    const running: ObservedRun = { runId: "run-manager", source: "github", status: "running", startedAt: NOW.toISOString() };
    await refused(await handler(ENABLED, managed, { ...listening, managerRuns: observed([running]) })(request(), MEMBER), 409, "already_running");
    expect(managed.delivered).toEqual([]);
  });

  test("refuses a head still running on a replaced deployment or stored as running, but not one stored running past the stuck time", async () => {
    const live: ObservedRun = { runId: "run-live", source: "github", status: "running", startedAt: new Date(NOW.getTime() - 60_000).toISOString() };
    const replaced = { ...ANCHOR, runId: "anchor-0", address: "anchor-0@tenant.example" };
    const onReplaced: GithubPrTriageDeps["observeRuns"] = async (anchorRunId, domain) => (anchorRunId === replaced.runId ? observed([live]) : observed([]))(anchorRunId, domain);
    const s = stub();
    await refused(await handler(ENABLED, s, { liveDeployments: async () => [ANCHOR, replaced], observeRuns: onReplaced })(request(), MEMBER), 409, "already_running");
    const running = (agoMs: number): PrTriageRow => ({ ...queuedRow(agoMs), status: "running", runId: "run-live" });
    await refused(await handler(ENABLED, s, { store: stored([running(60_000)], s.saved) })(request(), MEMBER), 409, "already_running");
    expect(s.delivered).toEqual([]);
    expect((await handler(ENABLED, s, { store: stored([running(2 * DEFAULT_RECONCILE_POLICY.stuckAfterMs)], s.saved) })(request(), MEMBER)).status).toBe(202);
    expect(s.delivered).toEqual([{ payload: expect.anything() }]);
  });

  test("refuses a head the hub queued within the unstarted grace; one queued longer ago is requeued keeping its attempts", async () => {
    const s = stub();
    await refused(await handler(ENABLED, s, { store: stored([queuedRow(60_000)], s.saved) })(request(), MEMBER), 409, "already_queued");
    expect(s.delivered).toEqual([]);
    const old = queuedRow(2 * DEFAULT_RECONCILE_POLICY.unstartedAfterMs);
    expect((await handler(ENABLED, s, { store: stored([old], s.saved) })(request(), MEMBER)).status).toBe(202);
    expect(s.delivered).toHaveLength(1);
    expect(s.saved).toEqual([[{ ...old, queuedAt: NOW.toISOString(), updatedAt: NOW.toISOString() }]]);
  });

  test("a head a live manager holds is running, and one whose manager reported done or went away since it was queued is queued again at once", async () => {
    const queued = queuedRow(60_000);
    const manager = (run: ObservedRun): Partial<GithubPrTriageDeps> => ({ store: stored([queued], s.saved), managerRuns: async () => observed([run])("", "") });
    const s = stub();
    await refused(await handler(ENABLED, s, manager({ runId: "run_manager", source: "github", status: "running", startedAt: NOW.toISOString() }))(request(), MEMBER), 409, "already_running");
    await refused(await handler(ENABLED, s, manager({ runId: "run_manager", source: "github", status: "completed", startedAt: new Date(NOW.getTime() - 120_000 - DEFAULT_RECONCILE_POLICY.clockSkewMs).toISOString() }))(request(), MEMBER), 409, "already_queued");
    expect(s.delivered).toEqual([]);
    expect((await handler(ENABLED, s, manager({ runId: "run_manager", source: "github", status: "completed", startedAt: new Date(NOW.getTime() - 30_000).toISOString() }))(request(), MEMBER)).status).toBe(202);
    expect(s.delivered).toHaveLength(1);
    expect((await handler(ENABLED, s, manager({ runId: "run_manager", source: "github", status: "failed", startedAt: new Date(NOW.getTime() - 30_000).toISOString() }))(request(), MEMBER)).status).toBe(202);
    expect(s.delivered).toHaveLength(2);
  });

  test("a state write refused as stale is retried once on a fresh load, gate included; refused twice it answers conflict, never mailing", async () => {
    const s = stub();
    expect((await handler(ENABLED, s, { store: stored([], s.saved, 1) })(request(), MEMBER)).status).toBe(202);
    expect(s.saved).toHaveLength(1);
    expect(s.delivered).toHaveLength(1);
    const theirs: GithubPrTriageDeps["store"] = {
      async load() { return { rows: [], version: null }; },
      async save() { throw new TriageStateConflictError(REPO); },
    };
    await refused(await handler(ENABLED, s, { store: theirs })(request(), MEMBER), 409, "conflict");
    let loads = 0;
    const queuedByThem: GithubPrTriageDeps["store"] = {
      async load() { return { rows: loads++ === 0 ? [] : [queuedRow(1_000)], version: VERSION }; },
      async save() { throw new TriageStateConflictError(REPO); },
    };
    await refused(await handler(ENABLED, s, { store: queuedByThem })(request(), MEMBER), 409, "already_queued");
    expect(s.delivered).toHaveLength(1);
  });

  test("a mail that fails puts the row back and tells the maintainer to try again", async () => {
    const at = (agoMs: number) => new Date(NOW.getTime() - agoMs).toISOString();
    const capped: PrTriageRow = { number: 8, headSha: "abc123", status: "failed", attempts: 5, runId: "run-5", error: "run failed", firstSeenAt: at(7_200_000), queuedAt: at(3_600_000), updatedAt: at(3_600_000) };
    const s = stub();
    const send: GithubPrTriageDeps["send"] = async () => { throw new Error("sidecar refused the mail"); };
    const res = await handler(ENABLED, s, { store: stored([capped], s.saved), send })(request(), MEMBER);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "hub_unavailable", message: `Could not queue ${REPO}#8: sidecar refused the mail. Try again.` } });
    const { error: _error, ...kept } = capped;
    expect(s.saved).toEqual([[{ ...kept, status: "queued", queuedAt: NOW.toISOString(), updatedAt: NOW.toISOString() }], [capped]]);
    const fresh = stub();
    await handler(ENABLED, fresh, { store: stored([], fresh.saved), send })(request(), MEMBER);
    expect(fresh.saved.at(-1)).toEqual([]);
  });

  test("GitHub's rate limit while routing the mail answers github_rate_limited with Retry-After and puts the row back", async () => {
    const s = stub();
    const resetAt = Date.now() + 60_000;
    async function send(): Promise<void> {
      throw new GithubRateLimited("1", resetAt);
    }
    const res = await handler(ENABLED, s, { send })(request(), MEMBER);
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: { code: "github_rate_limited", resetAt: new Date(resetAt).toISOString() } });
    expect(s.saved.at(-1)).toEqual([]);
  });

  test("a second click before the run starts is refused once the hub has passed over the queued head", async () => {
    const at = (agoMs: number) => new Date(NOW.getTime() - agoMs).toISOString();
    const oldVerdict: ObservedRun = { runId: "run-old", source: "github", status: "completed", startedAt: at(3_600_000), workflowVersion: "0.1.0-sha-1" };
    let rows: PrTriageRow[] = [{ number: 8, headSha: "abc123", status: "triaged", attempts: 1, runId: "run-old", workflowVersion: "0.1.0-sha-1", firstSeenAt: at(7_200_000), queuedAt: at(3_600_000), updatedAt: at(3_600_000) }];
    const s = stub();
    const store: GithubPrTriageDeps["store"] = { async load() { return { rows, version: VERSION }; }, async save(_t, _r, next) { rows = next; return VERSION; } };
    const deps = { store, observeRuns: observed([oldVerdict]) };
    expect((await handler(ENABLED, s, deps)(request(), MEMBER)).status).toBe(202);
    rows = planTenant({
      repos: [{ name: REPO, prs: [{ number: 8, headSha: "abc123", updatedAt: at(3_600_000), draft: false }], rows }],
      runs: new Map([[REPO, new Map([["8@abc123", [oldVerdict]]])]]),
      now: NOW, policy: DEFAULT_RECONCILE_POLICY, workflowVersion: "0.1.0-sha-1",
    }).get(REPO)!.rows;
    const second = await handler(ENABLED, s, deps)(request(), MEMBER);
    expect({ status: second.status, delivered: s.delivered.length, row: rows[0]!.status }).toEqual({ status: 409, delivered: 1, row: "queued" });
  });
});
