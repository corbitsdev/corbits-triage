import { describe, expect, test } from "bun:test";
import { formatRunAddress } from "@intx/types";
import { emptyPack, type ActionKind, type CheckPack, type PrTriageRow } from "@corbits/triage-contracts";
import type { CheckRun } from "@corbits/github-reads";
import { unsettledBy } from "@corbits/triage-workflows/logic/settled";
import { DEFAULT_RECONCILE_POLICY, planTenant, runKey, type ObservedRun, type OpenPr } from "./reconcile-plan.js";
import { triageReconcilePolicy } from "../env.js";
import { TriageStateConflictError, type TriageStateStore } from "./triage-state-store.js";
import type { LiveDeployment } from "./deployment.js";
import type { HostedVerdict } from "./verdict-record-store.js";
import { createTriageReconciler, type ReconcileOutcome } from "./triage-reconciler.js";
import { createReconcileLoop } from "./reconcile-loop.js";
import { createRepoActivity, type RepoActivity } from "./repo-activity.js";
import { GithubRateLimited } from "./github-usage.js";
import { markBaseMoved } from "./triage-queue.js";
import { evaluate, rules } from "@corbits/triage-workflows/actions/index";
import { readFacts } from "@corbits/triage-workflows/actions/facts";

const REPO = "acme/widgets";
const DOMAIN = "acme.test";
const TENANT_ID = "tnt_acme";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const LONG_AGO = "2026-10-07T00:00:00.000Z";
const STARTED = "2026-10-07T01:00:00.000Z";
const LISTENER = { runId: "run_listener", address: formatRunAddress("run_listener", DOMAIN), createdAt: new Date(LONG_AGO), cancelling: false };
const MINUTE = 60_000;
const BASE_MOVE_WINDOW = DEFAULT_RECONCILE_POLICY.baseMoveWindowMs / MINUTE;

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * MINUTE);
}
let failNextRead = false;

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
  github?: boolean;
  maxInFlight?: string;
  refuseSaves?: number;
  onRefusedSave?: (repo: string) => void;
  now?: () => Date;
  /** The host's listener; a live one when not given. */
  listener?: LiveDeployment | undefined;
  pack?: CheckPack;
  automatic?: ActionKind[];
  noPack?: boolean;
  /** Why the policy can't be read. */
  unreadable?: string;
  /** Build statuses of every head, for a host whose builds the reconciler polls. */
  headChecks?: CheckRun[];
  /** Stored triage state of the repository before the first pass. */
  rows?: PrTriageRow[];
  /** Verdicts the hub recorded. */
  recorded?: HostedVerdict[];
  activity?: RepoActivity;
  /** Thrown by every listing of open pull requests while set. */
  listError?: Error;
  /** Thrown by the mail of these pull requests. */
  sendErrors?: Record<number, Error>;
};

/** `runs` is what the managers' runs are on each pass. */
function harness(runs: Runs | (() => Runs), prs: OpenPr[] | Record<string, OpenPr[]>, options: HarnessOptions = {}) {
  const repos = Array.isArray(prs) ? { [REPO]: prs } : prs;
  function tenant() {
    const ns = { repos: Object.keys(repos).map((name) => ({ name, connected: true, enabled: true })) };
    return { id: TENANT_ID, domain: DOMAIN, config: { corbitsTriage: ns } };
  }
  const delivered: Delivered = [];
  const saved = new Map<string, PrTriageRow[]>(options.rows ? [[REPO, options.rows]] : []);
  let refusals = options.refuseSaves ?? 0;
  const logged: Array<Record<string, unknown>> = [];
  const listings: string[] = [];
  const now = options.now ?? (() => NOW);
  const reconcile = createTriageReconciler({
    source: "github",
    tenants: async function tenants() {
      return [tenant()];
    },
    listener: async () => ("listener" in options ? options.listener : LISTENER),
    openHeadsFor: async function openHeadsFor() {
      if (options.github === false) return undefined;
      return async function openHeads(record) {
        listings.push(record.name);
        if (options.listError) throw options.listError;
        return repos[record.name]!;
      };
    },
    activity: options.activity ?? { stale: () => true },
    managerRuns: async function managerRuns() {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("transient read failure");
      }
      const byRepo = typeof runs === "function" ? runs() : runs;
      return { byRepo: new Map(Object.entries(byRepo).map(([repo, byHead]) => [repo, new Map(Object.entries(byHead))])) };
    },
    headChecks: async () => options.headChecks ?? [],
    verdicts: { latest: async () => options.recorded ?? [] },
    store: store(),
    readCheckPack: async function readCheckPack(_tenantId, repo) {
      if (options.noPack) return { status: "missing" };
      if (options.unreadable) return { status: "invalid", reason: options.unreadable, path: ".corbits-triage.yml", automatic: options.automatic ?? [] };
      return { status: "ok", pack: options.pack ?? { ...emptyPack(repo), checks: { "no-merge-conflicts": { enabled: true } } }, automatic: options.automatic ?? [], source: { file: { path: ".corbits-triage.yml", sha: "art_pack-1" } } };
    },
    send: async function send({ number, payload }) {
      const refused = options.sendErrors?.[number];
      if (refused) throw refused;
      delivered.push({ payload: payload as Record<string, unknown> });
    },
    policy: triageReconcilePolicy({ ...(options.maxInFlight !== undefined && { TRIAGE_MAX_IN_FLIGHT: options.maxInFlight }) }),
    now,
    log: (entry) => logged.push(entry),
  });
  function store(): TriageStateStore {
    return {
      async load(_tenantId, repo) {
        return { rows: saved.get(repo) ?? [], version: { artifactId: `art_${repo}`, version: 1 } };
      },
      async save(_tenantId, repo, rows, expected) {
        if (refusals > 0) {
          refusals -= 1;
          options.onRefusedSave?.(repo);
          throw new TriageStateConflictError(repo);
        }
        saved.set(repo, rows);
        return expected;
      },
    };
  }
  return { reconcile, listings, delivered, saved, logged, store: store() };
}

describe("triage reconciler", () => {
  test("a host without a live listener is left alone", async () => {
    const run = harness({}, [head(1)], { listener: undefined });
    await run.reconcile();
    expect(run.delivered).toEqual([]);
    expect(run.logged).toContainEqual(expect.objectContaining({ msg: "triage_reconcile_skipped", reason: "no_listener" }));
  });

  test("a host whose listener is live is caught up", async () => {
    const run = harness({}, [head(1)], { listener: LISTENER });
    await run.reconcile();
    expect(mailedNumbers(run.delivered)).toEqual([1]);
  });

  test("a head mailed through the listener is mailed once while its manager runs and once it reported", async () => {
    let minutes = 0;
    let managed: Runs = {};
    const run = harness(() => managed, [head(1)], { listener: LISTENER, now: () => at(minutes) });
    await run.reconcile();
    managed = runsOf([1, ran("run_manager", 1, undefined, at(1).toISOString())]);
    for (minutes = 1; minutes <= 3; minutes++) await run.reconcile();
    managed = runsOf([1, ran("run_manager", 1, current(1), at(1).toISOString())]);
    for (minutes = 4; minutes <= 60; minutes += 14) await run.reconcile();
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
    expect(finished.logged).toContainEqual(expect.objectContaining({ msg: "triage_requeued", pr: 1, reason: "build_status_changed" }));
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

  test("a verdict that read CI as cancelled is not queued again while it stays cancelled, however many reads, and is once a check is re-run", async () => {
    const cancelled = { ...current(1), repo: REPO, number: 1, state: "awaiting-review", actor: "system", humanGated: false, checks: [{ check: "ci-green", kind: "machine", result: "unconfirmed", output: { kind: "values", values: { status: "cancelled" } } }] };
    let now = NOW;
    const options: HarnessOptions = { now: () => now, recorded: [recordedOf("run_1", cancelled)], headChecks: [{ name: "build", status: "completed", conclusion: "cancelled" }] };
    const run = harness(runsOf([1, ran("run_1", 1, cancelled)]), [head(1)], options);
    for (let pass = 0; pass <= DEFAULT_RECONCILE_POLICY.maxAttempts; pass++) {
      now = new Date(now.getTime() + DEFAULT_RECONCILE_POLICY.backoffMaxMs);
      await run.reconcile();
    }
    expect(run.delivered).toHaveLength(0);
    options.headChecks = [{ name: "build", status: "completed", conclusion: "success" }];
    now = new Date(now.getTime() + DEFAULT_RECONCILE_POLICY.backoffMaxMs);
    await run.reconcile();
    expect(mailedNumbers(run.delivered)).toEqual([1]);
  });

  test("a head whose recorded verdict waits on CI is queued again once CI finished", async () => {
    const triaged: PrTriageRow = { number: 1, headSha: "sha1", status: "triaged", attempts: 1, runId: "run_gone", firstSeenAt: LONG_AGO, updatedAt: LONG_AGO };
    const recorded: HostedVerdict = { tenantId: TENANT_ID, runId: "run_gone", repo: REPO, source: "github", number: 1, headSha: "sha1", startedAt: new Date(LONG_AGO), verdictAt: new Date(LONG_AGO), settled: true, state: "awaiting-review", actor: "system", humanGated: false, degraded: null, checks: [{ check: "ci-green", result: "unconfirmed" }], dos: [], commented: false, detail: null, trigger: "pull_request:opened", runStatus: null };
    const run = harness({}, [head(1)], { rows: [triaged], recorded: [recorded], headChecks: [{ name: "build", status: "completed", conclusion: "success" }] });
    await run.reconcile();
    expect(mailedNumbers(run.delivered)).toEqual([1]);
    expect(run.logged).toContainEqual(expect.objectContaining({ msg: "triage_requeued", pr: 1, reason: "build_status_changed" }));
    // Without the rule's detail, cancelled CI is taken as already read, so the head is not run again and again.
    const cancelled = harness({}, [head(1)], { rows: [triaged], recorded: [recorded], headChecks: [{ name: "build", status: "completed", conclusion: "cancelled" }] });
    await cancelled.reconcile();
    expect(cancelled.delivered).toHaveLength(0);
  });

  test("a head waiting on CI under another host's verdict of the same repository, number and head is not queued again", async () => {
    const triaged: PrTriageRow = { number: 1, headSha: "sha1", status: "triaged", attempts: 1, runId: "run_gone", firstSeenAt: LONG_AGO, updatedAt: LONG_AGO };
    const recorded: HostedVerdict = { tenantId: TENANT_ID, runId: "run_bitbucket", repo: REPO, source: "bitbucket-datacenter", number: 1, headSha: "sha1", startedAt: new Date(LONG_AGO), verdictAt: new Date(LONG_AGO), settled: true, state: "awaiting-review", actor: "system", humanGated: false, degraded: null, checks: [{ check: "ci-green", result: "unconfirmed" }], dos: [], commented: false, detail: null, trigger: "pull_request:opened", runStatus: null };
    const run = harness({}, [head(1)], { rows: [triaged], recorded: [recorded], headChecks: [{ name: "build", status: "completed", conclusion: "success" }] });
    await run.reconcile();
    expect(run.delivered).toHaveLength(0);
  });

  test("a repository with every rule off, or no policy, starts no run and is logged once per head", async () => {
    const off = harness({}, [head(1), head(2)], { pack: emptyPack(REPO) });
    await off.reconcile();
    expect(off.delivered).toHaveLength(0);
    await off.reconcile();
    expect(off.logged.filter((entry) => entry.msg === "triage_skipped_no_rules").map((entry) => entry.pulls)).toEqual([[1, 2]]);
    const unset = harness({}, [head(1)], { noPack: true });
    await unset.reconcile();
    await unset.reconcile();
    expect(unset.delivered).toHaveLength(0);
    expect(unset.logged.filter((entry) => entry.msg === "triage_skipped_no_policy")).toEqual([expect.objectContaining({ pulls: [1] })]);
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

  test("a degraded verdict is queued again and a clean one settles the head", async () => {
    const logs = runsOf([2, ran("run_degraded", 2, { degraded: "error", reason: "This repository still needs a policy." })], [3, ran("run_clean", 3, current(3))]);
    const { reconcile, delivered, saved } = harness(logs, [head(2), head(3)]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([2]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.find((row) => row.number === 2)).toMatchObject({ status: "queued", attempts: 1 });
    expect(rows.find((row) => row.number === 3)).toMatchObject({ status: "triaged", runId: "run_clean" });
  });

  test("verdicts on another commit or with unconfirmed checks are queued again with their reason", async () => {
    const unconfirmed = [{ check: "no-merge-conflicts", kind: "machine", result: "unconfirmed" }, { check: "docs", kind: "model", result: "unconfirmed" }];
    const logs = runsOf(
      [2, ran("run_other_head", 2, { ...current(2), headSha: "sha2-pushed" })],
      [3, ran("run_unconfirmed", 3, { ...current(3), checks: unconfirmed })],
      [4, ran("run_not_asked", 4, { ...current(4), checks: [{ check: "docs", kind: "model", result: "unconfirmed" }] })],
      [5, ran("run_ci_pending", 5, { ...current(5), checks: [{ check: "ci-green", kind: "machine", result: "unconfirmed" }, { check: "docs", kind: "model", result: "pass" }] })],
    );
    const { reconcile, delivered, saved, logged } = harness(logs, [head(2), head(3), head(4), head(5)]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([2, 3]);
    const reasons = logged.filter((entry) => entry["msg"] === "triage_requeued").map((entry) => entry["reason"]);
    expect(reasons).toEqual(["verdict made on head sha2-pushed", "unconfirmed checks: no-merge-conflicts"]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.filter((row) => row.number < 4).every((row) => row.status === "queued" && row.attempts === 1)).toBe(true);
    expect(rows.find((row) => row.number === 4)).toMatchObject({ status: "triaged", runId: "run_not_asked" });
    // Running checks settle; the completed check_run webhook triages the head again.
    expect(rows.find((row) => row.number === 5)).toMatchObject({ status: "triaged", runId: "run_ci_pending" });
  });

  test("a facts failure evaluates to a degraded verdict naming no head, which is queued again with the facts error", async () => {
    function unreachable(): never {
      throw new Error("facts read the host");
    }
    const read = await readFacts({ kind: "pr", repo: REPO, policy: { enabled: true }, checkPack: emptyPack(REPO) }, () => unreachable);
    const ctx = {} as never;
    const signal = new AbortController().signal;
    const verdict = await evaluate(await rules(read, ctx, signal), ctx, signal) as Record<string, unknown>;
    expect(verdict).toMatchObject({ degraded: "error", headSha: null, reason: "facts: pr input has no prNumber" });
    const logs = runsOf([1, ran("run_fail", 1, verdict)]);
    const { reconcile, delivered, logged } = harness(logs, [head(1)]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1]);
    expect(logged.find((entry) => entry["msg"] === "triage_requeued")?.["reason"]).toBe("degraded: facts: pr input has no prNumber");
  });

  test("a merge triages the repository's other settled heads again, not the merged one or another repository's", async () => {
    const OTHER = "acme/gadgets";
    const runs: Runs = { ...settled(1, 3), [OTHER]: { [runKey(4, "sha4")]: [ran("run_other", 4, current(4))] } };
    let now = NOW;
    const open = { [REPO]: heads(1, 3), [OTHER]: [head(4)] };
    const { reconcile, delivered, saved, logged, store } = harness(() => runs, open, { now: () => now });
    await reconcile();
    expect(delivered).toEqual([]);

    now = at(1);
    open[REPO] = [head(1), head(3)];
    expect(await markBaseMoved(store, TENANT_ID, REPO, 2, now, DEFAULT_RECONCILE_POLICY)).toBe(2);
    now = at(2);
    await reconcile();
    expect(mailedHeads(delivered)).toEqual([[REPO, 1], [REPO, 3]]);
    expect(logged.filter((entry) => entry["msg"] === "triage_requeued").map((entry) => entry["reason"])).toEqual(["base branch moved", "base branch moved"]);
    expect(saved.get(OTHER)?.[0]).toMatchObject({ status: "triaged" });

    for (const number of [1, 3]) runs[REPO]![runKey(number, `sha${number}`)]!.push(ran("run_recheck", number, current(number), at(2).toISOString()));
    now = at(3);
    await reconcile();
    expect(saved.get(REPO)?.map((row) => [row.number, row.status, row.runId])).toEqual([[1, "triaged", "run_recheck"], [3, "triaged", "run_recheck"]]);
  });

  test("a head in flight when the base branch moves runs again once its run ends and its base move window has passed", async () => {
    const runs = runsOf([1, ran("run_1", 1, undefined, at(-1).toISOString())], [3, ran("run_3", 3, current(3))]);
    const of1 = runs[REPO]![runKey(1, "sha1")]!;
    const of3 = runs[REPO]![runKey(3, "sha3")]!;
    let now = NOW;
    const { reconcile, delivered, saved, store } = harness(runs, [head(1), head(3)], { now: () => now });
    await reconcile();
    expect(saved.get(REPO)?.map((row) => row.status)).toEqual(["running", "triaged"]);

    now = at(1);
    expect(await markBaseMoved(store, TENANT_ID, REPO, 7, now, DEFAULT_RECONCILE_POLICY)).toBe(1);
    now = at(2);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([3]);
    expect(saved.get(REPO)?.map((row) => row.status)).toEqual(["running", "queued"]);

    // #3's run starts before a second merge and ends after it; #1's run outlives both.
    of3.push(ran("run_3b", 3, undefined, at(2.5).toISOString()));
    now = at(4);
    expect(await markBaseMoved(store, TENANT_ID, REPO, 8, now, DEFAULT_RECONCILE_POLICY)).toBe(0);
    now = at(5);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([3]);
    expect(saved.get(REPO)?.map((row) => row.status)).toEqual(["running", "running"]);

    of1.splice(0, 1, ran("run_1", 1, current(1), at(-1).toISOString()));
    of3.splice(1, 1, ran("run_3b", 3, current(3), at(2.5).toISOString()));
    now = at(6);
    await reconcile();
    // #1 was never queued by the hub, so it goes at once; #3, queued at minute 2, waits out its window.
    expect(mailedNumbers(delivered)).toEqual([3, 1]);

    of1.push(ran("run_1b", 1, current(1), at(6).toISOString()));
    now = at(1 + BASE_MOVE_WINDOW);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([3, 1]);
    now = at(2 + BASE_MOVE_WINDOW);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([3, 1, 3]);

    of3.push(ran("run_3c", 3, current(3), now.toISOString()));
    now = at(3 + BASE_MOVE_WINDOW);
    await reconcile();
    expect(saved.get(REPO)?.map((row) => [row.number, row.status, row.runId])).toEqual([[1, "triaged", "run_1b"], [3, "triaged", "run_3c"]]);
  });

  test("a merge re-checks a head that failed past its attempts, and counts only the heads it makes due", async () => {
    let now = NOW;
    const { reconcile, delivered, saved, store } = harness({}, [head(1), head(2)], { now: () => now });
    const capped: PrTriageRow = { number: 1, headSha: "sha1", status: "failed", attempts: DEFAULT_RECONCILE_POLICY.maxAttempts, error: "degraded: facts interrupted: abort", firstSeenAt: LONG_AGO, queuedAt: LONG_AGO, updatedAt: LONG_AGO };
    const backingOff: PrTriageRow = { ...capped, number: 2, headSha: "sha2", attempts: 1, queuedAt: NOW.toISOString() };
    saved.set(REPO, [capped, backingOff]);
    await reconcile();
    expect(delivered).toEqual([]);
    now = at(1);
    expect(await markBaseMoved(store, TENANT_ID, REPO, 9, now, DEFAULT_RECONCILE_POLICY)).toBe(1);
    now = at(2);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1]);
  });

  test("merges inside a head's base move window re-check it once when the window closes, not once per merge", async () => {
    const runs = settled(1, 2);
    let now = NOW;
    const { reconcile, delivered, store } = harness(runs, heads(1, 2), { now: () => now });
    await reconcile();
    now = at(1);
    await markBaseMoved(store, TENANT_ID, REPO, 9, now, DEFAULT_RECONCILE_POLICY);
    now = at(2);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2]);

    for (const number of [1, 2]) runs[REPO]![runKey(number, `sha${number}`)]!.push(ran("run_recheck", number, current(number), at(2).toISOString()));
    for (const minute of [4, 6, 8, 10, 12]) {
      now = at(minute);
      await markBaseMoved(store, TENANT_ID, REPO, minute, now, DEFAULT_RECONCILE_POLICY);
      now = at(minute + 1);
      await reconcile();
    }
    expect(delivered).toHaveLength(2);
    now = at(2 + BASE_MOVE_WINDOW);
    await reconcile();
    expect(delivered).toHaveLength(4);
    expect(mailedNumbers(delivered)).toEqual([1, 2, 1, 2]);
  });

  test("a run after a base move settles its head though the sidecar clock trails the hub's by under the skew allowance", () => {
    const moved = NOW.getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    const row: PrTriageRow = { number: 7, headSha: "abc", status: "queued", attempts: 1, firstSeenAt: LONG_AGO, queuedAt: iso(moved + 50), staleBefore: iso(moved), updatedAt: iso(moved + 50) };
    const run: ObservedRun = { runId: "run_after", source: "github", status: "completed", startedAt: iso(moved + 50 - 500) };
    const pr = { number: 7, headSha: "abc", updatedAt: LONG_AGO, draft: false };
    const plans = planTenant({ repos: [{ name: REPO, prs: [pr], rows: [row] }], runs: new Map([[REPO, new Map([["7@abc", [run]]])]]), now: at(1), policy: DEFAULT_RECONCILE_POLICY });
    expect(plans.get(REPO)!.rows[0]!.status).toBe("triaged");
  });

  test("the in-flight budget is per tenant across repositories, oldest pull requests first", async () => {
    const { reconcile, delivered } = harness({}, { "acme/one": heads(1, 3), "acme/two": heads(100, 3) });
    await reconcile();
    expect(mailedHeads(delivered)).toEqual([["acme/one", 1], ["acme/one", 2], ["acme/one", 3], ["acme/two", 100], ["acme/two", 101]]);
  });

  test("TRIAGE_MAX_IN_FLIGHT caps the heads queued per pass", async () => {
    const { reconcile, delivered } = harness({}, heads(1, 5), { maxInFlight: "2" });
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2]);
  });

  test("each head is its own job, keyed by that head", async () => {
    const { reconcile, delivered } = harness({}, heads(1, 3));
    await reconcile();
    expect(delivered.map((entry) => mailedNumbers([entry]))).toEqual([[1], [2], [3]]);
  });

  test("a mail that fails to send leaves its head failed with the error, and the rest of the batch is still sent", async () => {
    const { reconcile, delivered, saved } = harness({}, heads(1, 2), { sendErrors: { 1: new Error("502 Bad Gateway") } });
    await reconcile();
    expect(delivered.map((entry) => mailedNumbers([entry]))).toEqual([[2]]);
    expect(saved.get(REPO)?.find((row) => row.number === 1)).toMatchObject({ status: "failed", error: "delivery failed: Error: 502 Bad Gateway" });
  });

  test("queued heads that have not started hold the budget until their runs complete", async () => {
    const logs: Runs = { [REPO]: {} };
    const { reconcile, delivered, saved } = harness(logs, heads(1, 12));
    await reconcile();
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2, 3, 4, 5]);
    // Only a run started since the hub queued the head settles it.
    for (const number of [1, 2, 3, 4, 5]) logs[REPO]![runKey(number, `sha${number}`)] = [ran(`run_${number}`, number, current(number), "2026-10-07T12:00:30.000Z")];
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.filter((row) => row.status === "triaged").map((row) => row.number)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.filter((row) => row.status === "new").map((row) => row.number)).toEqual([11, 12]);
  });

  test("a state write refused as stale is retried once on the other writer's rows, keeping the newer row of each head", async () => {
    const { reconcile, delivered, saved, logged } = harness({}, [head(1), head(2)], {
      refuseSaves: 1,
      onRefusedSave: (repo) => saved.set(repo, [{ number: 1, headSha: "sha1", status: "queued", attempts: 3, firstSeenAt: LONG_AGO, queuedAt: "2026-10-07T12:00:30.000Z", updatedAt: "2026-10-07T12:00:30.000Z" }]),
    });
    await reconcile();
    const rows = saved.get(REPO) ?? [];
    expect(rows.map((row) => `${row.number}:${row.status}:${row.attempts}`)).toEqual(["1:queued:3", "2:queued:1"]);
    expect(mailedNumbers(delivered)).toEqual([2]);
    expect(logged).toContainEqual(expect.objectContaining({ msg: "triage_state_merged", repo: REPO, left: 1 }));
    const twice = harness({}, [head(1)], { refuseSaves: 2 });
    await twice.reconcile();
    expect(twice.saved.get(REPO)).toBeUndefined();
    expect(twice.delivered).toEqual([]);
    expect(twice.logged).toContainEqual(expect.objectContaining({ msg: "triage_state_conflict", repo: REPO }));
  });

  test("a head still running holds one of the tenant's slots", async () => {
    const logs = runsOf([1, ran("run_going", 1, undefined, "2026-10-07T11:55:00.000Z")]);
    const { reconcile, delivered } = harness(logs, heads(1, 7));
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([2, 3, 4, 5]);
  });

  test("heads first seen together queue lowest pull request number first, whatever order GitHub lists them", async () => {
    const { reconcile, delivered } = harness({}, heads(1, 10).reverse());
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a tenant without a GitHub credential is skipped with a reason", async () => {
    const { reconcile, delivered, logged } = harness({}, [head(1)], { github: false });
    await reconcile();
    expect(delivered).toEqual([]);
    expect(logged).toContainEqual(expect.objectContaining({ msg: "triage_reconcile_skipped", reason: "no_source_credential" }));
  });

  test("a repository is listed again once a webhook named it or half an hour passed, and every pass while its webhook heard nothing that long", async () => {
    let clock = NOW;
    const activity = createRepoActivity(() => clock, { quietMs: 30 * MINUTE, graceMs: MINUTE });
    const { reconcile, listings } = harness(settled(1, 1), { [REPO]: [head(1)], "acme/gadgets": [] }, { now: () => clock, activity });
    function hear(minutes: number, repo: string): void {
      clock = at(minutes);
      activity.heard(TENANT_ID, "github", repo);
    }
    async function pass(minutes: number): Promise<string[]> {
      clock = at(minutes);
      listings.length = 0;
      await reconcile();
      return [...listings];
    }
    expect(await pass(0)).toEqual([REPO, "acme/gadgets"]);
    hear(2, REPO);
    hear(2, "acme/gadgets");
    // A listing that started within a minute of the delivery may not show it yet, so it is read once more.
    expect(await pass(2)).toEqual([REPO, "acme/gadgets"]);
    expect(await pass(5)).toEqual([REPO, "acme/gadgets"]);
    expect(await pass(10)).toEqual([]);
    hear(12, REPO);
    expect(await pass(15)).toEqual([REPO]);
    expect(await pass(20)).toEqual([]);
    // Half an hour after its last listing a repository is listed again, in case a delivery for it was lost.
    expect(await pass(35)).toEqual(["acme/gadgets"]);
    // The App's webhook heard nothing for half an hour: it may be broken, so every pass lists every repository as before.
    expect(await pass(42)).toEqual([REPO, "acme/gadgets"]);
    expect(await pass(47)).toEqual([REPO, "acme/gadgets"]);
    // A Bitbucket webhook is each repository's own, so one repository's delivery says nothing of another's.
    clock = at(50);
    activity.heard(TENANT_ID, "bitbucket-datacenter", "PROJ/one");
    clock = at(55);
    expect(activity.stale(TENANT_ID, "bitbucket-datacenter", "PROJ/one", at(52).getTime())).toBe(false);
    expect(activity.stale(TENANT_ID, "bitbucket-datacenter", "PROJ/two", at(52).getTime())).toBe(true);
  });

  test("a repository's kept listing is dropped once the tenant's reader cannot be built, so the next pass reads again", async () => {
    let clock = NOW;
    const activity = createRepoActivity(() => clock, { quietMs: 30 * MINUTE, graceMs: MINUTE });
    const options = { now: () => clock, activity, github: true };
    const { reconcile, listings } = harness(settled(1, 1), [head(1)], options);
    activity.heard(TENANT_ID, "github", REPO);
    clock = at(2);
    await reconcile();
    options.github = false;
    clock = at(5);
    await reconcile();
    options.github = true;
    clock = at(10);
    await reconcile();
    expect(listings).toEqual([REPO, REPO]);
  });

  test("a listing GitHub rate limited is not kept, and the pass waits for the limit's reset", async () => {
    let clock = NOW;
    const activity = createRepoActivity(() => clock, { quietMs: 30 * MINUTE, graceMs: MINUTE });
    const options: HarnessOptions = { now: () => clock, activity };
    const { reconcile, listings } = harness(settled(1, 1), [head(1)], options);
    activity.heard(TENANT_ID, "github", REPO);
    clock = at(25);
    await reconcile();
    // The App's webhook went quiet, so the listing is read again, and GitHub refuses it.
    clock = at(31);
    options.listError = new GithubRateLimited("1", at(33).getTime());
    expect(await reconcile()).toEqual({ retry: false, retryAt: at(33).getTime() });
    options.listError = undefined;
    clock = at(32);
    activity.heard(TENANT_ID, "github", "acme/gadgets");
    clock = at(33);
    await reconcile();
    expect(listings).toEqual([REPO, REPO, REPO]);
  });

  test("a repository that fails to load asks for the early retry, and that pass queues its head", async () => {
    const options: HarnessOptions = { listError: new Error("connection reset") };
    const { reconcile, delivered } = harness({}, [head(1)], options);
    const passes: Array<Promise<ReconcileOutcome>> = [];
    function pass(): Promise<ReconcileOutcome> {
      const outcome = reconcile();
      passes.push(outcome);
      return outcome;
    }
    const retry = Promise.withResolvers<{ run: () => void; ms: number }>();
    function schedule(run: () => void, ms: number): void {
      retry.resolve({ run, ms });
    }
    const loop = createReconcileLoop(pass, { intervalMs: 300_000, retryMs: 15_000, retryMaxMs: 120_000, schedule }, () => {});
    loop.kick();
    const { run, ms } = await retry.promise;
    expect(ms).toBe(15_000);
    expect(delivered).toEqual([]);
    options.listError = undefined;
    run();
    await passes[1];
    expect(mailedNumbers(delivered)).toEqual([1]);
  });

  test("a tenant whose managers' runs cannot be read asks for another pass soon", async () => {
    const { reconcile } = harness({}, [head(1)]);
    failNextRead = true;
    expect(await reconcile()).toEqual({ retry: true });
  });
});
