// Judge eval: replays labelled pull requests through a deployed definition that triages, pr-triage or a PR workflow, on
// Interchange's local runner (the production step invoker, agents and directors, with GitHub served from the fixtures and
// the judge calling the production decision model) and checks each judged rule's answer and the verdict against its
// label. The judge is not deterministic, so each may miss a few cases. Each judge call is attempted once, as deployed: the
// judge director answers an inference error as a judge error instead of failing its step, so the step's retry never runs
// and those rules stay unsure. `--baseline` also writes results/<workflow>-judge.baseline.json, refusing on a dirty
// working tree or when any case's repository is not public. Run on its own, it evaluates pr-triage.
//
//   bun run eval   (in packages/triage-workflows)
//   bun run eval -- --baseline   also writes results/pr-triage-judge.baseline.json
import { readFileSync } from "node:fs";
import { EvalFailure, evaluate, type CheckFn, type Report } from "@corbits/evals";
import type { InferenceEvent } from "@intx/types/inference-events";
import { emptyPack, type CheckPack } from "../../triage-contracts/src/index.js";
import { startBaseline, writeBaseline, type Stamp } from "./baseline.js";
import { MODEL_CHECKS, SCORED, variant, type CaseInput, type Expected, type JudgeCase, type ModelCheck, type Scored } from "./cases.js";
import { fixture, pullOf } from "./fixtures.js";
import { addCost, costOf, priceKey, priceOf } from "./prices.js";
import { PR_TRIAGE, runDefinition, type Definition, type Endpoint } from "./run-definition.js";
import { fixtureGithub, triggerMail } from "./serve.js";

// The OpenCode Zen preset the production workspace's decision model uses.
const ENDPOINT: Endpoint = { kind: "custom", url: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13" };
const PROVIDER = "opencode-zen";
priceOf(priceKey(PROVIDER, ENDPOINT.model));
function requiredApiKey(): string {
  const key = process.env.OPENCODE_API_KEY;
  if (!key) throw new Error("OPENCODE_API_KEY is not set");
  return key;
}

const here = new URL(".", import.meta.url).pathname;
const CASES = `${here}cases.jsonl`;

type Outcomes = Record<Scored, "pass" | "fail" | "unsure">;

interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

const agents = new Set<string>();
const usage: Record<string, ModelUsage> = {};

function onEvent(event: InferenceEvent) {
  if (event.type !== "inference.done") return;
  const key = priceKey(PROVIDER, event.data.source.model);
  const total = (usage[key] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
  total.input += event.data.usage.input;
  total.output += event.data.usage.output;
  total.cacheRead += event.data.usage.cacheRead;
  total.cacheWrite += event.data.usage.cacheWrite;
  total.costUsd = addCost(total.costUsd, costOf(event.data.usage, priceOf(key)));
}

function onStepDone(agentId: string) {
  agents.add(agentId);
}

/** Every repository a case reads, mixes included. */
function caseRepos(): string[] {
  const cases = readFileSync(CASES, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as JudgeCase);
  return cases.flatMap(({ input }) => [input.pull, ...(input.mix === undefined ? [] : [input.mix])]).map((key) => pullOf(key)[0]);
}

function pack(repo: string): CheckPack {
  return { ...emptyPack(repo), checks: { focused: { enabled: true }, docs: { enabled: true } } };
}

function judgeWith(definition: Definition, apiKey: string, extra: Record<string, unknown>) {
  return async function judge(input: CaseInput): Promise<Outcomes> {
    const pr = variant(fixture(input.pull), input, input.mix === undefined ? undefined : fixture(input.mix));
    const { verdict } = await runDefinition({ definition, fetch: fixtureGithub(pr, {}), apiKey, endpoint: ENDPOINT, triggerPayload: triggerMail(pr, pack(pr.repo), extra), onEvent, onStepDone });
    function answer(check: ModelCheck): [ModelCheck, Outcomes[Scored]] {
      const result = verdict.checks.find((row) => row.check === check)?.result;
      return [check, result === "pass" || result === "fail" ? result : "unsure"];
    }
    const checks = Object.fromEntries(MODEL_CHECKS.map(answer));
    return { ...checks, verdict: verdict.verdict } as Outcomes;
  };
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

function writeJudgeBaseline(workflow: string, report: Report, stamp: Stamp) {
  function totals(check: Scored): [Scored, Record<string, number>] {
    const { passed, counted, missed } = report.checks[check]!;
    return [check, { passed, counted, missed, unsure: report.cases.filter((row) => row.checks[check]?.label === "unsure").length }];
  }
  function outcome(row: Report["cases"][number]) {
    const output = row.output as Outcomes | undefined;
    return {
      id: row.name,
      failed: row.error !== undefined,
      ...(output && { verdict: output.verdict, rules: Object.fromEntries(MODEL_CHECKS.map((check) => [check, output[check]])) }),
    };
  }
  const file = `${here}results/${workflow}-judge.baseline.json`;
  writeBaseline(file, {
    workflow,
    eval: "judge",
    steps: Object.fromEntries([...agents].map((id) => [id, { provider: PROVIDER, model: ENDPOINT.model }])),
    usage: Object.fromEntries(Object.entries(usage).map(([key, u]) => [key, { ...u, costUsd: u.costUsd === null ? null : Number(u.costUsd.toFixed(4)) }])),
    cases: report.cases.map(outcome),
    totals: Object.fromEntries(SCORED.map(totals)),
  }, stamp);
  console.log(`baseline: ${file}`);
}

/** Runs the judge eval through `definition`, its baseline named for `workflow`, with `extra` beside each mail's request. */
export async function judgeEval(definition: Definition, workflow: string, extra: Record<string, unknown> = {}) {
  const apiKey = requiredApiKey();
  const stamp = process.argv.includes("--baseline") ? startBaseline(caseRepos()) : undefined;
  function finish(report: Report) {
    printUnsure(report);
    if (stamp) writeJudgeBaseline(workflow, report, stamp);
  }
  try {
    finish(await evaluate("judge", {
      run: judgeWith(definition, apiKey, extra),
      cases: CASES,
      checks: Object.fromEntries(SCORED.map((check) => [check, answered(check)])),
      // Focused decided every case in each measured run; two misses leave room for answers near the band edge. Docs missed 5
      // of the 49 cases, all unsure, in the first run after the tests check was removed. The verdict missed 2, none unsure, in its first run.
      allow: { docs: 7, focused: 2, verdict: 4 },
      about: { model: ENDPOINT.model, workflow },
      concurrency: 2,
      timeout: "10m",
    }));
  } catch (error) {
    if (error instanceof EvalFailure) finish(error.report);
    throw error;
  }
}

if (import.meta.main) await judgeEval(PR_TRIAGE, "pr-triage");
