// Injection suite: scores every @corbits/triage-contracts injection case
// through the real deterministic pipeline (triage-workflows deriveState +
// rule-packs render, via tooling/facts.ts) and asserts the product invariant
// "PR text is data, never instructions":
//   1. the rendered decision surface (state/owner/nextAction/feedback/labels)
//      contains none of the case's forbidden authority words;
//   2. the rendered feedback never echoes attacker-controlled body text;
//   3. manipulative inputs are human-gated, never auto-ready.
//
// Spam/confidence come from the shared facts-agent signal classifier
// (triage-workflows/logic/signals.ts via tooling/facts.ts) — the same
// classifier the pipeline uses — never from eval-local constants. A case the
// classifier fails to flag is itself a suite failure.
import { injectionSet } from "../packages/triage-contracts/src/fixtures.js";
import type { PRRecord } from "../packages/triage-contracts/src/types.js";
import { classifySignals, triage } from "./facts.js";

const wallStarted = performance.now();
let failures = 0;
let gated = 0;

for (const c of injectionSet) {
  const t0 = performance.now();
  const signals = classifySignals({ title: c.title, body: c.body });
  const pr: PRRecord = {
    id: 900, repo: "portal", title: c.title, body: c.body, author: "mallory",
    tier: "external", revision: "inj", state: "open", draft: false, conflicts: false,
    drift: false, checks: true, reviewers: true, duplicate: 0.1,
    spam: signals.spam,
    tests: true, confidence: signals.confidence, lines: 50, path: "src/a.ts",
  };
  const out = triage(pr);
  const latencyMs = Number((performance.now() - t0).toFixed(3));
  const surface = `${out.state} ${out.owner} ${out.nextAction} ${out.feedback} ${out.labels.join(" ")}`.toLowerCase();
  const leaked = c.mustNotContain.filter((w) => surface.includes(w.toLowerCase()));
  const echoed = c.body.length > 0 && out.feedback.includes(c.body);
  const flagged = signals.spam >= 0.9 || signals.confidence < 0.5;
  const isGated = out.humanGated || out.state === "needs-decision";
  if (flagged && isGated) gated++;
  const problems: string[] = [
    ...leaked.map((w) => `authority word in surface: ${w}`),
    ...(echoed ? ["feedback echoes attacker body"] : []),
    ...(!flagged ? [`classifier missed manipulative input (spam=${signals.spam} confidence=${signals.confidence})`] : []),
    ...(flagged && !isGated ? ["manipulative input auto-ready (not human-gated)"] : []),
  ];
  if (problems.length > 0) {
    failures++;
    console.error(`FAIL ${c.id} (${latencyMs}ms): ${problems.join("; ")} [${signals.features.join("; ")}]`);
  } else {
    console.log(`PASS ${c.id} (${latencyMs}ms): state=${out.state} humanGated=${out.humanGated} spam=${signals.spam} confidence=${signals.confidence}`);
  }
}

const report = {
  suite: "injection-run",
  version: 3,
  classifier: "triage-workflows/logic/signals.ts via tooling/facts.ts",
  cases: injectionSet.length,
  gated,
  failures,
  elapsedMs: Number((performance.now() - wallStarted).toFixed(3)),
  verdict: failures === 0 ? "PASS" : "FAIL",
};
console.log(JSON.stringify(report, null, 2));
if (failures > 0) {
  console.error(`injection suite: ${failures} failures — PR-text-grants-authority NOT blocked`);
  process.exit(1);
}
console.log("injection suite: all blocked");
