import { describe, expect, test } from "bun:test";
import type { PrTriageRow } from "@corbits/triage-contracts";
import { DEFAULT_RECONCILE_POLICY, planTenant, requeue, runKey, type ObservedRun, type OpenPr, type RepoPlan } from "./reconcile-plan.js";

const MINUTE = 60_000;
const T0 = new Date("2026-10-07T00:00:00.000Z");
const policy = DEFAULT_RECONCILE_POLICY;

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * MINUTE);
}

function pr(number: number, headSha = `sha${number}`): OpenPr {
  return { number, headSha, updatedAt: at(-1_000).toISOString(), draft: false };
}

function run(runId: string, status: ObservedRun["status"], startedMinute: number): ObservedRun {
  return { runId, source: "github", status, startedAt: at(startedMinute).toISOString() };
}

const REPO = "acme/widgets";

function plan(prs: OpenPr[], rows: readonly PrTriageRow[], now: Date, runs: Array<[OpenPr, ObservedRun[]]> = [], maxInFlight = prs.length): RepoPlan {
  const byHead = new Map(runs.map(([open, observed]) => [runKey(open.number, open.headSha), observed]));
  const input = { repos: [{ name: REPO, prs, rows }], runs: new Map([[REPO, byHead]]), now, policy: { ...policy, maxInFlight } };
  return planTenant(input).get(REPO)!;
}

function row(number: number, extra: Partial<PrTriageRow>): PrTriageRow {
  return { number, headSha: `sha${number}`, status: "new", attempts: 0, firstSeenAt: at(-500).toISOString(), updatedAt: at(-500).toISOString(), ...extra };
}

function enqueued(result: RepoPlan): number[] {
  return result.enqueue.map((entry) => entry.number);
}

function status(result: RepoPlan, number: number): PrTriageRow | undefined {
  return result.rows.find((row) => row.number === number);
}

describe("reconcile plan", () => {
  test("a hub restart that lost every webhook queues each untriaged head once", () => {
    const first = plan([pr(1), pr(2)], [], at(60));
    expect(enqueued(first)).toEqual([1, 2]);
    expect(first.rows.every((row) => row.status === "queued" && row.attempts === 1)).toBe(true);

    const again = plan([pr(1), pr(2)], first.rows, at(61));
    expect(enqueued(again)).toEqual([]);
  });

  test("a head updated inside the webhook grace waits for its webhook run", () => {
    const fresh = { ...pr(3), updatedAt: at(59).toISOString() };
    expect(enqueued(plan([fresh], [], at(60)))).toEqual([]);
    expect(enqueued(plan([fresh], [], at(62)))).toEqual([3]);
  });

  test("a queued head is settled only by a run started since it was queued; an older verdict does not count", () => {
    const queued = plan([pr(1)], [], at(0)).rows;
    const settled = plan([pr(1)], queued, at(20), [[pr(1), [run("run_old", "completed", -10), run("run_new", "completed", 1)]]]);
    expect(enqueued(settled)).toEqual([]);
    expect(status(settled, 1)).toMatchObject({ status: "triaged", runId: "run_new" });
    const failed = plan([pr(1)], queued, at(200), [[pr(1), [run("run_old", "completed", -10), run("run_new", "failed", 1)]]]);
    expect(enqueued(failed)).toEqual([1]);
    expect(status(failed, 1)).toMatchObject({ status: "queued", attempts: 2 });
  });

  test("a run whose sidecar died is queued again once it is stuck", () => {
    const queued = plan([pr(1)], [], at(0)).rows;
    const running = plan([pr(1)], queued, at(30), [[pr(1), [run("run_a", "running", 1)]]]);
    expect(enqueued(running)).toEqual([]);
    expect(status(running, 1)).toMatchObject({ status: "running", runId: "run_a" });

    const stuck = plan([pr(1)], running.rows, at(92), [[pr(1), [run("run_a", "running", 1)]]]);
    expect(enqueued(stuck)).toEqual([1]);
    expect(status(stuck, 1)).toMatchObject({ status: "queued", attempts: 2 });
  });

  test("a queued mail lost before any run started is queued again", () => {
    const queued = plan([pr(1)], [], at(0)).rows;
    expect(enqueued(plan([pr(1)], queued, at(9)))).toEqual([]);
    expect(enqueued(plan([pr(1)], queued, at(11)))).toEqual([1]);
  });

  test("failed runs retry with backoff and stop at the attempt cap", () => {
    let rows = plan([pr(1)], [], at(0)).rows;
    const runs: ObservedRun[] = [];
    let minute = 0;
    for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
      runs.push(run(`run_${attempt}`, "failed", minute + 1));
      const backoff = Math.min(policy.backoffBaseMs * 2 ** (attempt - 1), policy.backoffMaxMs) / MINUTE;
      const early = plan([pr(1)], rows, at(minute + backoff - 1), [[pr(1), runs]]);
      expect(enqueued(early)).toEqual([]);
      expect(status(early, 1)).toMatchObject({ status: "failed", runId: `run_${attempt}` });
      minute += backoff;
      const retried = plan([pr(1)], early.rows, at(minute), [[pr(1), runs]]);
      expect(enqueued(retried)).toEqual([1]);
      rows = retried.rows;
    }
    runs.push(run("run_last", "failed", minute + 1));
    const capped = plan([pr(1)], rows, at(minute + 100_000), [[pr(1), runs]]);
    expect(enqueued(capped)).toEqual([]);
    expect(status(capped, 1)).toMatchObject({ status: "failed", attempts: policy.maxAttempts });
  });

  test("a head's last attempt is decided even while the host's checks are pending", () => {
    const failed = (attempts: number) => row(1, { status: "failed", attempts, error: "unconfirmed checks: no-merge-conflicts", firstSeenAt: at(0).toISOString(), queuedAt: at(0).toISOString() });
    expect(plan([pr(1)], [failed(policy.maxAttempts - 2)], at(41)).enqueue).toEqual([{ number: 1, reason: "unconfirmed checks: no-merge-conflicts" }]);
    expect(plan([pr(1)], [failed(policy.maxAttempts - 1)], at(41)).enqueue).toEqual([{ number: 1, reason: "unconfirmed checks: no-merge-conflicts", noWait: true }]);
  });

  test("a webhook run that failed is retried at once without spending backoff", () => {
    const result = plan([pr(1)], [], at(60), [[pr(1), [run("run_hook", "failed", 30)]]]);
    expect(enqueued(result)).toEqual([1]);
  });

  test("a new head starts over and closed pull requests drop out", () => {
    const triaged = plan([pr(1), pr(2)], [], at(60), [[pr(1), [run("r1", "completed", 1)]], [pr(2), [run("r2", "completed", 1)]]]);
    expect(enqueued(triaged)).toEqual([]);
    const pushed = plan([pr(1, "sha1b")], triaged.rows, at(120));
    expect(enqueued(pushed)).toEqual([1]);
    expect(pushed.rows).toHaveLength(1);
    expect(pushed.rows[0]).toMatchObject({ headSha: "sha1b", attempts: 1 });
  });

  test("a completed run with an unsettled verdict counts as failed with its reason", () => {
    const degraded = { ...run("run_d", "completed", 1), unsettled: "This repository still needs a policy." };
    const result = plan([pr(1)], [], at(60), [[pr(1), [degraded]]]);
    expect(enqueued(result)).toEqual([1]);
    expect(result.enqueue[0]?.reason).toBe("This repository still needs a policy.");
  });

  test("a verdict waiting on an unconfirmed check is retried after its own delay, up to the attempt cap", () => {
    const unconfirmed = (runId: string, minute: number): ObservedRun => ({ ...run(runId, "completed", minute), unsettled: "unconfirmed checks: conflicts", unconfirmed: true });
    const runs: ObservedRun[] = [unconfirmed("run_w", 0)];
    const early = plan([pr(1)], [], at(4), [[pr(1), runs]]);
    expect(enqueued(early)).toEqual([]);
    expect(status(early, 1)).toMatchObject({ status: "failed", attempts: 0, error: "unconfirmed checks: conflicts" });
    let rows = early.rows;
    let deliveries = 0;
    for (let minute = 5; minute < 24 * 60; minute += 5) {
      const pass = plan([pr(1)], rows, at(minute), [[pr(1), runs]]);
      if (pass.enqueue.length > 0) {
        deliveries += 1;
        runs.push(unconfirmed(`run_${minute}`, minute + 1));
      }
      rows = pass.rows;
    }
    expect(deliveries).toBe(policy.maxAttempts);
    expect(rows[0]).toMatchObject({ status: "failed", attempts: policy.maxAttempts });
  });

  test("a run started on a sidecar whose clock trails the hub still matches the hub's queue", () => {
    const queued = plan([pr(1)], [], at(0)).rows;
    const result = plan([pr(1)], queued, at(3), [[pr(1), [{ ...run("run_a", "failed", 0), startedAt: at(-0.5).toISOString() }]]]);
    expect(status(result, 1)).toMatchObject({ status: "failed", runId: "run_a", attempts: 1, error: "run failed" });
    const before = plan([pr(1)], queued, at(11), [[pr(1), [run("run_old", "failed", -5)]]]);
    expect(status(before, 1)).toMatchObject({ status: "queued", attempts: 2 });
  });

  test("a webhook run that fails fast does not override the hub's run still going", () => {
    const queued = plan([pr(1)], [], at(0)).rows;
    const running = plan([pr(1)], queued, at(1), [[pr(1), [run("run_hub", "running", 0.1)]]]).rows;
    const result = plan([pr(1)], running, at(3), [[pr(1), [run("run_hub", "running", 0.1), run("run_hook", "failed", 2)]]]);
    expect(enqueued(result)).toEqual([]);
    expect(status(result, 1)).toMatchObject({ status: "running", runId: "run_hub" });

    const ended = plan([pr(1)], result.rows, at(4), [[pr(1), [run("run_hub", "failed", 0.1), run("run_hook", "failed", 2)]]]);
    expect(status(ended, 1)).toMatchObject({ status: "failed", runId: "run_hub" });
  });

  test("only maxInFlight heads are queued at once, oldest waiting first, and the rest drain as runs complete", () => {
    const prs = Array.from({ length: 300 }, (_, i) => pr(i + 1));
    const seen = plan(prs, [], at(0), [], 0);
    expect(enqueued(seen)).toEqual([]);
    let rows = seen.rows.map((row, i) => ({ ...row, firstSeenAt: at(-i).toISOString() }));
    const runs: Array<[OpenPr, ObservedRun[]]> = [];
    const passes: number[][] = [];
    for (let minute = 1; rows.some((row) => row.status !== "triaged"); minute += 1) {
      const pass = plan(prs, rows, at(minute), runs, policy.maxInFlight);
      expect(pass.rows.filter((row) => row.status === "queued")).toHaveLength(Math.min(policy.maxInFlight, pass.enqueue.length));
      if (pass.enqueue.length > 0) passes.push(enqueued(pass));
      for (const queued of pass.enqueue) runs.push([pr(queued.number), [run(`run_${queued.number}`, "completed", minute)]]);
      rows = pass.rows;
    }
    expect(passes).toHaveLength(300 / policy.maxInFlight);
    expect(passes[0]).toEqual([300, 299, 298, 297, 296]);
    expect(passes.flat().sort((a, b) => a - b)).toEqual(prs.map((open) => open.number));
  });

  test("a manager waiting for its head's CI holds no in-flight slot, and one judging or reviewing does", () => {
    const prs = [1, 2, 3].map((number) => pr(number));
    const queued = row(1, { status: "queued", attempts: 1, queuedAt: at(0).toISOString() });
    const working = run("run_1", "running", 1);
    const waiting = { ...working, waitingSince: at(1).toISOString() };
    expect(enqueued(plan(prs, [queued], at(2), [[pr(1), [waiting]]], 2))).toEqual([2, 3]);
    expect(enqueued(plan(prs, [queued], at(2), [[pr(1), [working]]], 2))).toEqual([2]);
  });

  test("never-triaged heads are queued before heads due again, even when they were seen later", () => {
    const stale = [1, 2, 3, 4].map((number) => row(number, { status: "failed", attempts: 1, firstSeenAt: at(-100 + number).toISOString(), queuedAt: at(-90).toISOString(), error: "degraded: facts interrupted: abort" }));
    const result = plan([pr(5), pr(6), pr(7), ...stale.map((row) => pr(row.number))], stale, at(0), [], policy.maxInFlight);
    expect(enqueued(result)).toEqual([5, 6, 7, 1, 2]);
  });

  test("a run still going for a superseded head, a closed pull request or an unloaded repository holds its slot", () => {
    const running = [run("r_live", "running", -5)];
    const runs = new Map([
      [REPO, new Map([[runKey(1, "sha1-old"), running], [runKey(99, "sha99"), running]])],
      ["acme/unloaded", new Map([[runKey(7, "sha7"), running]])],
    ]);
    const rows = [row(1, { headSha: "sha1-old", status: "running", runId: "r_live", queuedAt: at(-6).toISOString() })];
    const prs = [pr(1, "sha1-new"), pr(2), pr(3), pr(4), pr(5), pr(6)];
    const plans = planTenant({ repos: [{ name: REPO, prs, rows }], runs, now: at(0), policy });
    expect(enqueued(plans.get(REPO)!)).toEqual([1, 2]);
  });

  test("a retried head waits behind every never-attempted head, even ones first seen after it was last queued", () => {
    const rows = [
      row(1, { status: "failed", attempts: 1, queuedAt: at(-60).toISOString() }),
      ...[2, 3, 4, 5, 6].map((n) => row(n, { firstSeenAt: at(-100).toISOString() })),
      ...[7, 8].map((n) => row(n, { firstSeenAt: at(-10).toISOString() })),
    ];
    const prs = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => pr(n));
    expect(enqueued(plan(prs, rows, at(0), [], 5))).toEqual([2, 3, 4, 5, 6]);
    expect(enqueued(plan(prs, rows, at(0), [], 6))).toEqual([2, 3, 4, 5, 6, 7]);
    expect(enqueued(plan(prs, rows, at(0), [], 8))).toEqual([2, 3, 4, 5, 6, 7, 8, 1]);
  });

  test("a wedged hub whose runs never start spends at most five queued heads at a time and five attempts per head", () => {
    const prs = Array.from({ length: 20 }, (_, i) => pr(i + 1));
    let rows: PrTriageRow[] = [];
    let mails = 0;
    const exhausted = () => rows.length > 0 && rows.every((r) => r.status === "failed" && r.attempts === policy.maxAttempts);
    for (let minute = 0; minute < 60 * 48 && !exhausted(); minute += 5) {
      const pass = plan(prs, rows, at(minute), [], policy.maxInFlight);
      mails += pass.enqueue.length;
      expect(pass.rows.filter((r) => r.status === "queued").length).toBeLessThanOrEqual(policy.maxInFlight);
      rows = pass.rows;
    }
    expect(exhausted()).toBe(true);
    expect(mails).toBe(20 * policy.maxAttempts);
  });

  test("a head capped by runs that never started gets a fresh ladder after cappedRetryAfterMs, behind never-triaged heads", () => {
    const capped = (number: number, error: string) => row(number, { status: "failed", attempts: policy.maxAttempts, error, queuedAt: at(-11).toISOString(), updatedAt: at(0).toISOString() });
    const rows = [capped(1, "run never started"), capped(2, "run failed")];
    const hour = 60;
    expect(enqueued(plan([pr(1), pr(2)], rows, at(5 * hour), [], 2))).toEqual([]);
    const retried = plan([pr(1), pr(2)], rows, at(6 * hour), [], 2);
    expect(enqueued(retried)).toEqual([1]);
    expect(status(retried, 1)).toMatchObject({ status: "queued", attempts: 1, cappedRetries: 1 });
    expect(status(retried, 2)).toMatchObject({ status: "failed", attempts: policy.maxAttempts });
    expect(enqueued(plan([pr(1), pr(2)], rows, at(1_000 * hour), [], 2))).toEqual([1]);
    expect(enqueued(plan([pr(1), pr(3)], [rows[0]!], at(6 * hour), [], 1))).toEqual([3]);
    expect(status(plan([pr(1)], [rows[0]!], at(6 * hour), [], 0), 1)).toMatchObject({ status: "failed", attempts: 0 });
    expect(enqueued(plan([pr(1)], [{ ...rows[0]!, cappedRetries: policy.cappedRetryCycles - 1 }], at(6 * hour)))).toEqual([1]);
    expect(enqueued(plan([pr(1)], [{ ...rows[0]!, cappedRetries: policy.cappedRetryCycles }], at(1_000 * hour)))).toEqual([]);
  });

  test("a stuck run from before the hub queued the head again does not fail the new attempt", () => {
    const queued = plan([pr(1)], [], at(200)).rows;
    const result = plan([pr(1)], queued, at(205), [[pr(1), [run("run_dead", "running", 0)]]]);
    expect(enqueued(result)).toEqual([]);
    expect(status(result, 1)).toMatchObject({ status: "queued" });
  });
});

describe("triage again on a head that already has a verdict", () => {
  // The route's write on top of a triaged row: queued, queuedAt now, runId kept.
  const requeued: PrTriageRow = { number: 8, headSha: "sha8", status: "queued", attempts: 0, runId: "run-old", firstSeenAt: at(-120).toISOString(), queuedAt: at(-1).toISOString(), updatedAt: at(-1).toISOString() };
  const oldVerdict = run("run-old", "completed", -60);

  test("the next pass keeps the head queued until the maintainer's run starts", () => {
    expect(plan([pr(8)], [requeued], at(0), [[pr(8), [oldVerdict]]]).rows[0]!.status).toBe("queued");
  });

  test("the next pass reports the maintainer's running run, not the old verdict", () => {
    expect(plan([pr(8)], [requeued], at(0), [[pr(8), [oldVerdict, run("run-new", "running", 0)]]]).rows[0]).toMatchObject({ status: "running", runId: "run-new" });
  });
});

describe("a head queued again because its CI changed", () => {
  function requeued(attempts: number, minute: number): RepoPlan {
    const result: RepoPlan = { rows: [row(1, { status: "triaged", runId: "run1", attempts, firstSeenAt: at(0).toISOString() })], enqueue: [] };
    requeue(result, result.rows[0]!, "build_status_changed", at(minute), policy);
    return result;
  }

  test("keeps its attempts however often CI changes, so a failed run after them is still retried", () => {
    let rows: readonly PrTriageRow[] = [row(1, { status: "triaged", runId: "run0", attempts: 1, firstSeenAt: at(0).toISOString() })];
    for (const minute of [1, 2, 3, 4, 5, 6]) {
      const result: RepoPlan = { rows: [...rows], enqueue: [] };
      requeue(result, rows[0]!, "build_status_changed", at(minute), policy);
      expect(result.enqueue).toEqual([{ number: 1, reason: "build_status_changed" }]);
      rows = plan([pr(1)], result.rows, at(minute), [[pr(1), [run(`run${minute}`, "completed", minute)]]]).rows;
    }
    expect(rows[0]).toMatchObject({ status: "triaged", attempts: 1 });
    const queued = { ...rows[0]!, status: "queued" as const, queuedAt: at(7).toISOString() };
    const retried = plan([pr(1)], [queued], at(200), [[pr(1), [run("run7", "failed", 7)]]]);
    expect(enqueued(retried)).toEqual([1]);
    expect(status(retried, 1)).toMatchObject({ status: "queued", attempts: 2 });
  });

  test("is decided without waiting on its last attempt", () => {
    expect(requeued(4, 1).enqueue).toEqual([{ number: 1, reason: "build_status_changed" }]);
    expect(requeued(5, 1).enqueue).toEqual([{ number: 1, reason: "build_status_changed", noWait: true }]);
    expect(status(requeued(5, 1), 1)).toMatchObject({ status: "queued", attempts: 5 });
  });
});
