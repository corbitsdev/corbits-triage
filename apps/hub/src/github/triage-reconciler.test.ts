import { describe, expect, test } from "bun:test";
import { formatRunAddress } from "@intx/types";
import { DEFAULT_TIMINGS, emptyPack, type ActionKind, type PrTriageRow } from "@corbits/triage-contracts";
import type { CheckRun } from "@corbits/github-reads";
import { unsettledBy } from "@corbits/triage-workflows/logic/settled";
import { DEFAULT_RECONCILE_POLICY, runKey, type ObservedRun, type OpenPr } from "./reconcile-plan.js";
import { triageReconcilePolicy } from "../env.js";
import { DEFAULT_MAIL_HOLD_MS } from "../timings.js";
import type { TriageStateStore } from "./triage-state-store.js";
import type { HostedVerdict } from "./verdict-record-store.js";
import { createTriageReconciler, createUnroutedTries } from "./triage-reconciler.js";
import { markBaseMoved } from "./triage-queue.js";

const REPO = "acme/widgets";
const DOMAIN = "acme.test";
const TENANT_ID = "tnt_acme";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const LONG_AGO = "2026-10-07T00:00:00.000Z";
const STARTED = "2026-10-07T01:00:00.000Z";
const LISTENER = { runId: "run_listener", address: formatRunAddress("run_listener", DOMAIN), createdAt: new Date(LONG_AGO), cancelling: false };
const MINUTE = 60_000;

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * MINUTE);
}

function head(number: number): OpenPr {
  return { number, headSha: `sha${number}`, updatedAt: LONG_AGO, draft: false };
}

function heads(from: number, count: number): OpenPr[] {
  return Array.from({ length: count }, (_, i) => head(from + i));
}

function current(number: number): Record<string, unknown> {
  return { degraded: null, reason: "", headSha: `sha${number}`, checks: [] };
}

/** A manager's run of `number`'s head as the hub reads it: running, or completed with what its verdict settles. */
function ran(runId: string, number: number, verdict?: Record<string, unknown>, startedAt = STARTED): ObservedRun {
  if (!verdict) return { runId, source: "github", status: "running", startedAt };
  return { runId, source: "github", status: "completed", startedAt, ...unsettledBy(verdict, `sha${number}`) };
}

/** The managers' runs by repository, then by head. */
type Runs = Record<string, Record<string, ObservedRun[]>>;

function runsOf(...observed: Array<[number, ObservedRun]>): Runs {
  const byHead: Record<string, ObservedRun[]> = {};
  for (const [number, run] of observed) (byHead[runKey(number, `sha${number}`)] ??= []).push(run);
  return { [REPO]: byHead };
}

function settled(from: number, count: number): Runs {
  return runsOf(...heads(from, count).map(({ number }): [number, ObservedRun] => [number, ran(`run_${number}`, number, current(number))]));
}

/** The verdict the hub recorded from `runId`, as the build poll reads it. */
function recordedOf(runId: string, verdict: { checks: Array<{ check: string; result: string }> }): HostedVerdict {
  return { tenantId: TENANT_ID, runId, repo: REPO, source: "github", number: 1, headSha: "sha1", startedAt: new Date(STARTED), verdictAt: new Date(STARTED), settled: true, state: "awaiting-review", actor: "system", humanGated: false, degraded: null, checks: verdict.checks.map(({ check, result }) => ({ check, result })), dos: [], commented: false, detail: { checks: verdict.checks } as HostedVerdict["detail"], trigger: "pull_request:opened", runStatus: null };
}

type Delivered = Array<{ payload: Record<string, unknown> }>;

function mailedHeads(delivered: Delivered): Array<[string, number]> {
  return delivered.flatMap((entry) => (entry.payload["items"] as Array<{ prNumber: number }>).map((item): [string, number] => [entry.payload["repo"] as string, item.prNumber]));
}

function mailedNumbers(delivered: Delivered): number[] {
  return mailedHeads(delivered).map(([, number]) => number);
}

type HarnessOptions = {
  maxInFlight?: string;
  now?: () => Date;
  automatic?: ActionKind[];
  /** Why the policy can't be read. */
  unreadable?: string;
  /** Build statuses of every head, for a host whose builds the reconciler polls. */
  headChecks?: CheckRun[];
  /** Verdicts the hub recorded. */
  recorded?: HostedVerdict[];
};

/** `runs` is what the managers' runs are on each pass. */
function harness(runs: Runs | (() => Runs), prs: OpenPr[] | Record<string, OpenPr[]>, options: HarnessOptions = {}) {
  const repos = Array.isArray(prs) ? { [REPO]: prs } : prs;
  function tenant() {
    const ns = { repos: Object.keys(repos).map((name) => ({ name, connected: true, enabled: true })) };
    return { id: TENANT_ID, domain: DOMAIN, config: { corbitsTriage: ns } };
  }
  const delivered: Delivered = [];
  const saved = new Map<string, PrTriageRow[]>();
  const now = options.now ?? (() => NOW);
  const reconcile = createTriageReconciler({
    source: "github",
    tenants: async function tenants() {
      return [tenant()];
    },
    listener: async () => LISTENER,
    openHeadsFor: async function openHeadsFor() {
      return async function openHeads(record) {
        return repos[record.name]!;
      };
    },
    activity: { stale: () => true },
    managerRuns: async function managerRuns() {
      const byRepo = typeof runs === "function" ? runs() : runs;
      return { byRepo: new Map(Object.entries(byRepo).map(([repo, byHead]) => [repo, new Map(Object.entries(byHead))])), roomless: new Set<string>() };
    },
    headChecks: async () => options.headChecks ?? [],
    verdicts: { latest: async () => options.recorded ?? [] },
    store: store(),
    readCheckPack: async function readCheckPack(_tenantId, repo) {
      if (options.unreadable) return { status: "invalid", reason: options.unreadable, path: ".corbits-triage.yml", automatic: options.automatic ?? [] };
      return { status: "ok", pack: { ...emptyPack(repo), checks: { "no-merge-conflicts": { enabled: true } } }, automatic: options.automatic ?? [], source: { file: { path: ".corbits-triage.yml", sha: "art_pack-1" } } };
    },
    send: async function send({ payload }) {
      delivered.push({ payload: payload as Record<string, unknown> });
    },
    unroutedTries: createUnroutedTries(),
    policy: triageReconcilePolicy({ ...(options.maxInFlight !== undefined && { TRIAGE_MAX_IN_FLIGHT: options.maxInFlight }) }, { mailHoldMs: DEFAULT_MAIL_HOLD_MS, reconcileIntervalMs: DEFAULT_TIMINGS.reconcileIntervalMs }),
    now,
    log() {},
  });
  function store(): TriageStateStore {
    return {
      async load(_tenantId, repo) {
        return { rows: saved.get(repo) ?? [], version: { artifactId: `art_${repo}`, version: 1 } };
      },
      async save(_tenantId, repo, rows, expected) {
        saved.set(repo, rows);
        return expected;
      },
    };
  }
  return { reconcile, delivered, saved, store: store() };
}

describe("triage reconciler", () => {
  test("an open pull request whose webhook never arrived is triaged", async () => {
    const run = harness({}, [head(1)]);
    await run.reconcile();
    expect(mailedNumbers(run.delivered)).toEqual([1]);
  });

  test("a host without build webhooks: a head whose verdict waits on CI is queued again once its builds stop pending", async () => {
    const waiting = { ...current(1), repo: REPO, number: 1, state: "awaiting-review", actor: "system", humanGated: false, checks: [{ check: "ci-green", kind: "machine", result: "unconfirmed" }] };
    const logs = runsOf([1, ran("run_1", 1, waiting)]);
    const recorded = [recordedOf("run_1", waiting)];
    const pending = harness(logs, [head(1)], { recorded, headChecks: [{ name: "build", status: "in_progress", conclusion: null }] });
    await pending.reconcile();
    expect(pending.delivered).toHaveLength(0);
    const finished = harness(logs, [head(1)], { recorded, headChecks: [{ name: "build", status: "completed", conclusion: "success" }] });
    await finished.reconcile();
    expect(mailedNumbers(finished.delivered)).toEqual([1]);
    // A verdict that failed on CI is polled too: red turning green is caught without another event.
    const failed = { ...waiting, checks: [{ check: "ci-green", kind: "machine", result: "fail" }] };
    const red = runsOf([1, ran("run_1", 1, failed)]);
    const stillRed = harness(red, [head(1)], { recorded: [recordedOf("run_1", failed)], headChecks: [{ name: "build", status: "completed", conclusion: "failure" }] });
    await stillRed.reconcile();
    expect(stillRed.delivered).toHaveLength(0);
    const green = harness(red, [head(1)], { recorded: [recordedOf("run_1", failed)], headChecks: [{ name: "build", status: "completed", conclusion: "success" }] });
    await green.reconcile();
    expect(mailedNumbers(green.delivered)).toEqual([1]);
    const nowCancelled = harness(logs, [head(1)], { recorded, headChecks: [{ name: "build", status: "completed", conclusion: "cancelled" }] });
    await nowCancelled.reconcile();
    expect(mailedNumbers(nowCancelled.delivered)).toEqual([1]);
  });

  test("a policy triage can't read mails each open head with why and no pack, so the run marks it failed", async () => {
    const run = harness({}, [head(1)], { unreadable: "The policy file has unknown checks: max-size.", automatic: ["labels"] });
    await run.reconcile();
    expect(run.delivered.map((entry) => entry.payload)).toEqual([expect.objectContaining({ policyUnreadable: "The policy file has unknown checks: max-size.", automatic: ["labels"], items: [{ prNumber: 1, headSha: "sha1" }] })]);
    expect(run.delivered[0]!.payload).not.toHaveProperty("pack");
  });

  test("draft heads are not queued", async () => {
    const { reconcile, delivered } = harness({}, [{ ...head(1), draft: true }, head(2)]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([2]);
  });

  test("a merge triages the repository's other settled heads again, not the merged one or another repository's", async () => {
    const OTHER = "acme/gadgets";
    const runs: Runs = { ...settled(1, 3), [OTHER]: { [runKey(4, "sha4")]: [ran("run_other", 4, current(4))] } };
    let now = NOW;
    const open = { [REPO]: heads(1, 3), [OTHER]: [head(4)] };
    const { reconcile, delivered, saved, store } = harness(() => runs, open, { now: () => now });
    await reconcile();
    expect(delivered).toEqual([]);

    now = at(1);
    open[REPO] = [head(1), head(3)];
    expect(await markBaseMoved(store, TENANT_ID, REPO, 2, now, DEFAULT_RECONCILE_POLICY)).toBe(2);
    now = at(2);
    await reconcile();
    expect(mailedHeads(delivered)).toEqual([[REPO, 1], [REPO, 3]]);
    expect(saved.get(OTHER)?.[0]).toMatchObject({ status: "triaged" });

    for (const number of [1, 3]) runs[REPO]![runKey(number, `sha${number}`)]!.push(ran("run_recheck", number, current(number), at(2).toISOString()));
    now = at(3);
    await reconcile();
    expect(saved.get(REPO)?.map((row) => [row.number, row.status, row.runId])).toEqual([[1, "triaged", "run_recheck"], [3, "triaged", "run_recheck"]]);
  });

  test("TRIAGE_MAX_IN_FLIGHT caps the heads queued per pass", async () => {
    const { reconcile, delivered } = harness({}, heads(1, 5), { maxInFlight: "2" });
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2]);
  });
});
