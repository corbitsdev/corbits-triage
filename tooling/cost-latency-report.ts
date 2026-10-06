// Cost/latency report: runs every @corbits/triage-contracts holdback PR
// through the real deterministic pipeline (via tooling/facts.ts), measuring
// wall-clock latency per PR. The fixtures contain no provider, wallet, or run
// accounting, so cost is explicitly unavailable rather than estimated.
import { holdbackSet } from "../packages/triage-contracts/src/fixtures.js";
import { triage } from "./facts.js";

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function round3(n: number): number {
  return Number(n.toFixed(3));
}

const wallStarted = performance.now();
const latencies: number[] = [];

for (const pr of holdbackSet) {
  const t0 = performance.now();
  triage(pr);
  latencies.push(performance.now() - t0);
}

latencies.sort((a, b) => a - b);
const n = holdbackSet.length;
const report = {
  prs: n,
  method: "measured wall-clock per PR over the deterministic pipeline",
  cost: {
    status: "unavailable",
    reason: "Holdback fixtures contain no provider, wallet, or run accounting.",
  },
  latencyP50Ms: round3(quantile(latencies, 0.5)),
  latencyP95Ms: round3(quantile(latencies, 0.95)),
  latencyMaxMs: round3(latencies[n - 1] ?? 0),
  elapsedMs: round3(performance.now() - wallStarted),
};
console.log(JSON.stringify(report, null, 2));
