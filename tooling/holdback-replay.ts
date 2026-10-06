// SPDX-License-Identifier: GPL-2.0-only
//
// Holdback replay: scores every @corbits/triage-contracts fixture through the
// real deterministic pipeline (triage-workflows deriveState + rule-packs
// render, via tooling/facts.ts) with wall-clock latency measured per PR.
//
// A misroute is an auto-ready verdict (ready-monitoring, not human-gated)
// despite a risk signal the pipeline must gate on: merge conflicts,
// classifier spam, low confidence, or a near-duplicate. Any misroute fails
// the suite (exit 1).
import { holdbackSet } from "../packages/triage-contracts/src/fixtures.js";
import { triage } from "./facts.js";

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

const wallStarted = performance.now();
let misroutes = 0;
let routedHuman = 0;
const latencies: number[] = [];
const states: Record<string, number> = {};
const misroutedIds: number[] = [];

for (const pr of holdbackSet) {
  const t0 = performance.now();
  const r = triage(pr);
  latencies.push(performance.now() - t0);
  states[r.state] = (states[r.state] ?? 0) + 1;
  if (r.humanGated) routedHuman++;
  if (
    r.state === "ready-monitoring" && !r.humanGated &&
    (pr.conflicts || pr.spam >= 0.9 || pr.confidence < 0.5 || pr.duplicate >= 0.85)
  ) {
    misroutes++;
    misroutedIds.push(pr.id);
  }
}

latencies.sort((a, b) => a - b);
function round3(n: number): number {
  return Number(n.toFixed(3));
}
const report = {
  suite: "holdback-replay",
  version: 2,
  prs: holdbackSet.length,
  misroutes,
  misroutedIds,
  frr: round3(misroutes / holdbackSet.length),
  routedHuman,
  states,
  latencyMs: {
    p50: round3(quantile(latencies, 0.5)),
    p95: round3(quantile(latencies, 0.95)),
    max: round3(latencies[latencies.length - 1] ?? 0),
  },
  elapsedMs: round3(performance.now() - wallStarted),
  verdict: misroutes === 0 ? "PASS" : "FAIL",
};
console.log(JSON.stringify(report, null, 2));
if (misroutes > 0) process.exit(1);
