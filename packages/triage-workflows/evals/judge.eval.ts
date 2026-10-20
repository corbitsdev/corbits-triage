// Judge eval: replays labelled pull requests through the deployed pr-triage definition on Interchange's local runner (the
// production step invoker, agents and directors, with GitHub served from the fixtures and the judge calling the
// production decision model) and checks each judged rule's answer and the verdict against its label. The judge is not
// deterministic, so each may miss a few cases. Each judge call is attempted once, as deployed: the judge director answers
// an inference error as a judge error instead of failing its step, so the step's retry never runs and those rules stay unsure.
//
//   bun run eval   (in packages/triage-workflows)
import { EvalFailure, evaluate, type CheckFn, type Report } from "@corbits/evals";
import { emptyPack, type CheckPack } from "../../triage-contracts/src/index.js";
import { MODEL_CHECKS, SCORED, variant, type CaseInput, type Expected, type ModelCheck, type Scored } from "./cases.js";
import { fixture } from "./fixtures.js";
import { runDefinition, type Endpoint } from "./run-definition.js";
import { fixtureGithub, triggerMail } from "./serve.js";

// The OpenCode Zen preset the production workspace's decision model uses.
const ENDPOINT: Endpoint = { kind: "custom", url: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13" };
function requiredApiKey(): string {
  const key = process.env.OPENCODE_API_KEY;
  if (!key) throw new Error("OPENCODE_API_KEY is not set");
  return key;
}
const apiKey = requiredApiKey();

const here = new URL(".", import.meta.url).pathname;

type Outcomes = Record<Scored, "pass" | "fail" | "unsure">;

function pack(repo: string): CheckPack {
  return { ...emptyPack(repo), checks: { focused: { enabled: true }, docs: { enabled: true } } };
}

async function judge(input: CaseInput): Promise<Outcomes> {
  const pr = variant(fixture(input.pull), input, input.mix === undefined ? undefined : fixture(input.mix));
  const { verdict } = await runDefinition({ fetch: fixtureGithub(pr, {}), apiKey, endpoint: ENDPOINT, triggerPayload: triggerMail(pr, pack(pr.repo)) });
  function answer(check: ModelCheck): [ModelCheck, Outcomes[Scored]] {
    const result = verdict.checks.find((row) => row.check === check)?.result;
    return [check, result === "pass" || result === "fail" ? result : "unsure"];
  }
  const checks = Object.fromEntries(MODEL_CHECKS.map(answer));
  return { ...checks, verdict: verdict.verdict } as Outcomes;
}

/** Right when the check answered what its label expects; the answer is the label, so unsure answers show apart. */
function answered(check: Scored): CheckFn<CaseInput, Outcomes, Expected> {
  return function right({ output, expect }) {
    const got = output[check];
    return { pass: got === expect![check], value: got === expect![check] ? 1 : 0, label: got };
  };
}

/** Wrong and unsure answers both miss; how many were unsure says how often the judge declined to decide, and each miss is named with its answer. */
function printUnsure(report: Report) {
  for (const check of SCORED) {
    const missed = report.cases.filter((row) => row.checks[check]?.pass === false).map((row) => `${row.name} (${row.checks[check]?.label})`);
    console.log(`  ${check}: ${report.cases.filter((row) => row.checks[check]?.label === "unsure").length} unsure${missed.length ? `; missed ${missed.join(", ")}` : ""}`);
  }
}

try {
  printUnsure(await evaluate("judge", {
    run: judge,
    cases: `${here}cases.jsonl`,
    checks: Object.fromEntries(SCORED.map((check) => [check, answered(check)])),
    // Focused decided every case in each measured run; two misses leave room for answers near the band edge. Docs missed 5
    // of the 49 cases, all unsure, in the first run after the tests check was removed. The verdict missed 2, none unsure, in its first run.
    allow: { docs: 7, focused: 2, verdict: 4 },
    about: { model: ENDPOINT.model },
    concurrency: 2,
    timeout: "10m",
  }));
} catch (error) {
  if (error instanceof EvalFailure) printUnsure(error.report);
  throw error;
}
