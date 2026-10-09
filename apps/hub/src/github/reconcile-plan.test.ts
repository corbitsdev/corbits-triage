import { describe, expect, test } from "bun:test";
import type { PrTriageRow } from "@corbits/triage-contracts";
import { DEFAULT_RECONCILE_POLICY, planTenant, runKey, type ObservedRun, type OpenPr, type RepoPlan } from "./reconcile-plan.js";

const MINUTE = 60_000;
const T0 = new Date("2026-10-07T00:00:00.000Z");
const policy = DEFAULT_RECONCILE_POLICY;

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * MINUTE);
}

function pr(number: number, headSha = `sha${number}`): OpenPr {
  return { number, headSha, updatedAt: at(-1_000).toISOString() };
}

function run(runId: string, status: ObservedRun["status"], startedMinute: number): ObservedRun {
  return { runId, status, startedAt: at(startedMinute).toISOString() };
}

const REPO = "acme/widgets";

function plan(prs: OpenPr[], rows: readonly PrTriageRow[], now: Date, runs: Array<[OpenPr, ObservedRun[]]> = [], maxInFlight = prs.length): RepoPlan {
  const byHead = new Map(runs.map(([open, observed]) => [runKey(open.number, open.headSha), observed]));
  return planTenant({ repos: [{ name: REPO, prs, rows }], runs: new Map([[REPO, byHead]]), now, policy: { ...policy, maxInFlight } }).get(REPO)!;
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

  test("a completed run settles the head, even after it was queued again", () => {
    const queued = plan([pr(1)], [], at(0)).rows;
    const result = plan([pr(1)], queued, at(200), [[pr(1), [run("run_old", "completed", -10), run("run_new", "failed", 1)]]]);
    expect(enqueued(result)).toEqual([]);
    expect(status(result, 1)).toMatchObject({ status: "triaged", runId: "run_old" });
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

  test("a completed run with a degraded verdict counts as failed with its reason", () => {
    const degraded = { ...run("run_d", "completed", 1), degraded: "This repository still needs check setup." };
    const result = plan([pr(1)], [], at(60), [[pr(1), [degraded]]]);
    expect(enqueued(result)).toEqual([1]);
    expect(plan([pr(1)], [], at(60), [[pr(1), [degraded]]]).enqueue[0]?.undelivered).toMatchObject({
      status: "failed",
      runId: "run_d",
      error: "This repository still needs check setup.",
    });
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

  test("a retried head waits behind never-tried heads first seen before it was last queued, ahead of later ones", () => {
    const rows = [
      row(1, { status: "failed", attempts: 1, queuedAt: at(-60).toISOString() }),
      ...[2, 3, 4, 5, 6].map((n) => row(n, { firstSeenAt: at(-100).toISOString() })),
      ...[7, 8].map((n) => row(n, { firstSeenAt: at(-10).toISOString() })),
    ];
    const prs = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => pr(n));
    expect(enqueued(plan(prs, rows, at(0), [], 5))).toEqual([2, 3, 4, 5, 6]);
    expect(enqueued(plan(prs, rows, at(0), [], 6))).toEqual([2, 3, 4, 5, 6, 1]);
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

  test("a stuck run from before the hub queued the head again does not fail the new attempt", () => {
    const queued = plan([pr(1)], [], at(200)).rows;
    const result = plan([pr(1)], queued, at(205), [[pr(1), [run("run_dead", "running", 0)]]]);
    expect(enqueued(result)).toEqual([]);
    expect(status(result, 1)).toMatchObject({ status: "queued" });
  });
});
