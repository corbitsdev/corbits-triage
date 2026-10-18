// Finder eval: runs the pr-code-review definition with any finder system prompt over the cases in evals/labels/ and
// scores the findings against each case's answer key: a bug is caught when a finding on its path overlaps any of its
// sites within three lines; a finding that hits no bug is a false alarm. A finding with a `code` line is first moved onto
// that line in the diff. Writes a results JSON beside the table.
//
//   bun run eval:review -- --prompt <file.txt> --effort medium [--model claude-haiku-5-5] [--repo] [--cases a,b] [--max-tokens 1000000] [--out <file.json>]
//   --repo checks each case's head out (with `gh auth token`) and lets the finder read it; every tool call is recorded.
//   --budget <tokens> sets the repository finder's token budget (default the workflow's).
//   bun run eval:review -- --rescore <results-dir>   re-scores saved results without model calls
//   bun run eval:review -- --e2e [--cases a,b] [--<role>-model m] [--<role>-effort e] [--budget n] [--check] [--out <file.json>]
//   with <role> one of plan, diff-finder, repo-finder, consolidate, check, write; each role defaults to its deployed model;
//   runs the whole pr-code-review workflow on each case's head and scores the finders' union, the consolidated findings,
//   the confirmed ones (all of them unless --check), the final review, and its comments found by both finders and by
//   one, with each step's tokens, dollars and seconds.
//
// Inference is native Anthropic when ANTHROPIC_API_KEY is set, else OpenCode Zen with OPENCODE_API_KEY.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import type { InferenceEvent } from "@intx/types/inference-events";
import type { TokenUsage } from "@intx/types/runtime";
import type { AgentDefinition } from "@intx/agent";
import type { StepInvokeRequest, WorkflowAuthorizeFn } from "@intx/workflow";
import { stockTriggerMail } from "@corbits/triage-contracts";
import { runLocalWorkflow } from "../../triage-workflows/evals/run-local.js";
import { githubRead } from "@corbits/github-tool";
import * as actions from "../src/actions/index.js";
import { BUDGET_EXHAUSTED } from "@corbits/pr-code-review/actions/checkout";
import { finderAgent, repoFinderAgent, type Sources } from "../src/agents.js";
import * as directors from "../src/directors.js";
import { prCodeReview } from "../src/pr-code-review.js";
import { finderInput } from "./finder-input.js";
import { prCodeFinder } from "./finder-workflow.js";
import { headOf, loadCases, loadKeys, pullRequestOf, type Case, type CaseKey, type Reach } from "./cases.js";
import { parseFindings, REACHES, reanchor, scoreCase, type CaseScore, type Finding } from "./score.js";

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelPrice {
  price: Price;
  long?: { overPrompt: number; price: Price };
}

// Dollars per million tokens, with 5-minute cache writes. A Haiku 5.5 call whose prompt (input, cache reads and cache
// writes) is over 100k tokens pays the long-prompt prices for all of its tokens.
const PRICES: Record<string, ModelPrice> = {
  "claude-haiku-5-5": {
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    long: { overPrompt: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  },
  "claude-sonnet-5-5": { price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  "claude-opus-5-5": { price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
};

// The cases are GitHub pull requests.
const GITHUB: Sources = ["github"];

const EFFORTS = ["low", "medium", "high"] as const;
type Effort = (typeof EFFORTS)[number];

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

interface Provider {
  origin: string;
  apiKey: string;
}

interface ToolUse {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  error?: boolean;
}

interface CaseResult extends Partial<CaseScore> {
  id: string;
  kind: Case["kind"];
  usage: Usage;
  wallMs: number;
  tools?: ToolUse[];
  findings?: Finding[];
  reanchored?: number;
  recovered?: boolean;
  budgetExhausted?: boolean;
  unparsable?: string;
  failed?: string;
  reply?: string;
}

function provider(): Provider {
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (anthropic) return { origin: "https://api.anthropic.com", apiKey: anthropic };
  const zen = process.env.OPENCODE_API_KEY;
  if (zen) return { origin: "https://opencode.ai/zen", apiKey: zen };
  throw new Error("set ANTHROPIC_API_KEY or OPENCODE_API_KEY");
}

const allow: WorkflowAuthorizeFn = async () => ({ effect: "allow", matchingGrants: [], resolvedBy: null });

async function noGithub(input: string | URL | Request): Promise<Response> {
  throw new Error(`pr-code-review reached GitHub: ${String(input)}`);
}

/** GitHub reads with the gh CLI's token in place of the local placeholder secret; redirects stay unfollowed, as the credential handle leaves them. */
function ghGithub(): typeof fetch {
  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  return async function github(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.method !== "GET") throw new Error(`pr-code-review wrote to GitHub: ${request.method} ${request.url}`);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(new Request(request, { headers, redirect: "manual" }));
  } as typeof fetch;
}

function replyOf(output: unknown): string | undefined {
  return typeof output === "object" && output !== null && "reply" in output && typeof output.reply === "string" ? output.reply : undefined;
}

function totalTokens(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function costOf(call: TokenUsage, { price: base, long }: ModelPrice): number {
  const price = long && call.input + call.cacheRead + call.cacheWrite > long.overPrompt ? long.price : base;
  return (call.input * price.input + call.output * price.output + call.cacheRead * price.cacheRead + call.cacheWrite * price.cacheWrite) / 1e6;
}

/** How a case's finder reaches GitHub: not at all, or reading the case's head on an optional token budget. */
type RepoAccess = { github: typeof fetch; budget?: number } | undefined;

async function runCase(testCase: Case, systemPrompt: string, effort: Effort, model: string, source: Provider, repo: RepoAccess): Promise<CaseResult> {
  const price = priceOf(model);
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  const tools: ToolUse[] = [];
  function onEvent(event: InferenceEvent) {
    if (event.type === "tool.start") tools.push({ id: event.data.call.id, name: event.data.call.name, arguments: event.data.call.arguments });
    if (event.type === "tool.done" && event.data.result.isError) {
      const failed = tools.find((t) => t.id === event.data.result.callId);
      if (failed) failed.error = true;
    }
    if (event.type !== "inference.done") return;
    usage.input += event.data.usage.input;
    usage.output += event.data.usage.output;
    usage.cacheRead += event.data.usage.cacheRead;
    usage.cacheWrite += event.data.usage.cacheWrite;
    usage.costUsd += costOf(event.data.usage, price);
  }
  const head = repo && headOf(testCase.id);
  const base: CaseResult = { id: testCase.id, kind: testCase.kind, usage, wallMs: 0, ...(repo && { tools }) };
  const checkout = head && { checkout: { source: "github", ...head }, ...(repo.budget && { budget: repo.budget }) };
  const request = { kind: "code-review", title: testCase.title, description: testCase.description, diff: testCase.diff, effort, ...checkout };
  const started = performance.now();
  const run = await runLocalWorkflow({
    workflow: prCodeFinder({ systemPrompt }),
    directors: Object.values(directors),
    actions: { ...actions, finderInput },
    credentialBindings: repo ? [{ handle: "github", package: githubRead.id }] : [],
    authorize: allow,
    github: repo?.github ?? noGithub,
    inference: { credentialId: "inference", origin: source.origin, apiKey: source.apiKey },
    sourceFor: () => ({ id: "finder", provider: "anthropic", baseURL: source.origin, credentialId: "inference", model }),
    triggerPayload: stockTriggerMail(request),
    onEvent,
  });
  base.wallMs = Math.round(performance.now() - started);
  const reply = replyOf(run.outputs["find"] ?? run.outputs["findRepo"]);
  if (reply === undefined) return { ...base, failed: `ended ${run.terminalStatus} without a reply` };
  if (reply.startsWith(BUDGET_EXHAUSTED)) base.budgetExhausted = true;
  const parsed = parseFindings(reply);
  if ("unparsable" in parsed) return { ...base, unparsable: parsed.unparsable, reply };
  const { findings, moved } = reanchor(parsed.findings, testCase.diff);
  return { ...base, ...scoreCase(testCase, findings), findings, reanchored: moved, reply };
}

function deployedModel(agent: Pick<AgentDefinition, "inference">): string {
  const [source] = agent.inference.sources;
  if (!source) throw new Error("agent names no inference source");
  return source.model;
}

function priceOf(model: string): ModelPrice {
  const price = PRICES[model];
  if (!price) throw new Error(`no price for ${model}; known: ${Object.keys(PRICES).join(", ")}`);
  return price;
}

function sum<T>(results: readonly T[], pick: (result: T) => number): number {
  return results.reduce((total, result) => total + pick(result), 0);
}

function ratio(caught: number, total: number): string {
  return `${caught}/${total}`;
}

function summary(results: readonly CaseResult[], keys: readonly CaseKey[]) {
  const scored = keys.filter((key) => results.some((r) => r.id === key.id));
  const bugs = scored.flatMap((key) => key.bugs.map((bug) => ({ ...bug, caseId: key.id })));
  function isCaught(bug: (typeof bugs)[number]): boolean {
    return results.some((r) => r.id === bug.caseId && r.caught?.includes(bug.id));
  }
  function caughtOfReach(reach: Reach): [Reach, string] {
    const ofReach = bugs.filter((bug) => bug.reach === reach);
    return [reach, ratio(ofReach.filter(isCaught).length, ofReach.length)];
  }
  const usage: Usage = {
    input: sum(results, (r) => r.usage.input),
    output: sum(results, (r) => r.usage.output),
    cacheRead: sum(results, (r) => r.usage.cacheRead),
    cacheWrite: sum(results, (r) => r.usage.cacheWrite),
    costUsd: sum(results, (r) => r.usage.costUsd),
  };
  return {
    cases: results.length,
    bugsCaught: ratio(bugs.filter(isCaught).length, bugs.length),
    ...Object.fromEntries(REACHES.map(caughtOfReach)),
    falseAlarms: sum(results, (r) => r.falseAlarms ?? 0),
    cleanFlagged: ratio(results.filter((r) => r.flaggedClean).length, scored.filter((key) => key.kind === "clean").length),
    reanchored: sum(results, (r) => r.reanchored ?? 0),
    toolCalls: sum(results, (r) => r.tools?.length ?? 0),
    budgetExhausted: results.filter((r) => r.budgetExhausted).length,
    recovered: results.filter((r) => r.recovered).length,
    unparsable: results.filter((r) => r.unparsable !== undefined).length,
    failed: results.filter((r) => r.failed !== undefined).length,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheWriteTokens: usage.cacheWrite,
    cacheReadTokens: usage.cacheRead,
    costUsd: Number(usage.costUsd.toFixed(4)),
    wallSeconds: Math.round(sum(results, (r) => r.wallMs) / 1000),
  };
}

function caseRow(result: CaseResult, key: CaseKey) {
  return {
    id: result.id,
    kind: result.kind,
    caught: result.caught === undefined ? "-" : ratio(result.caught.length, key.bugs.length),
    falseAlarms: result.falseAlarms ?? "-",
    status: result.failed ?? result.unparsable ?? "ok",
    tools: result.tools?.length ?? "-",
    tokens: totalTokens(result.usage),
    seconds: Math.round(result.wallMs / 1000),
  };
}

/** A saved result scored again: its findings, already re-anchored, or those recovered from an unparsable reply, re-anchored. */
function rescored(saved: CaseResult, key: CaseKey): CaseResult {
  const { id, kind, usage, wallMs, failed, reply } = saved;
  const base = { id, kind, usage, wallMs, failed, reply };
  if (saved.findings) return { ...base, ...scoreCase(key, saved.findings), findings: saved.findings, reanchored: saved.reanchored ?? 0 };
  if (reply === undefined) return base;
  const parsed = parseFindings(reply);
  if ("unparsable" in parsed) return { ...base, unparsable: parsed.unparsable };
  const { findings, moved } = reanchor(parsed.findings, pullRequestOf(id).diff);
  return { ...base, ...scoreCase(key, findings), findings, reanchored: moved, recovered: saved.unparsable !== undefined };
}

/** The saved results of a finder run (--prompt); an --e2e run's results have no per-case usage or findings to rescore. */
function finderRun(file: string): { results: CaseResult[] } {
  const run = JSON.parse(readFileSync(file, "utf8")) as { results: CaseResult[]; stages?: unknown };
  if (run.stages !== undefined) throw new Error(`${file} is --e2e output; --rescore and --union take finder runs (--prompt)`);
  return run;
}

function keyOf(keys: readonly CaseKey[], id: string): CaseKey {
  const key = keys.find((k) => k.id === id);
  if (!key) throw new Error(`no answer key for ${id}`);
  return key;
}

function rescore(dir: string) {
  const keys = loadKeys();
  function rescoreFile(name: string) {
    const run = finderRun(join(dir, name));
    const results = run.results.map((saved) => rescored(saved, keyOf(keys, saved.id)));
    return { prompt: basename(name, ".json"), ...summary(results, keys) };
  }
  const rows = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map(rescoreFile)
    .sort((a, b) => Number.parseInt(b.bugsCaught) - Number.parseInt(a.bugsCaught) || a.falseAlarms - b.falseAlarms);
  const columns = ["prompt", "bugsCaught", ...REACHES, "falseAlarms", "cleanFlagged", "reanchored", "recovered", "unparsable", "costUsd"];
  console.table(rows, columns);
}


/** Each model step's role in the request, and the flag prefix that sets its model and effort. */
const ROLE_FLAGS = { plan: "plan", diffFinder: "diff-finder", repoFinder: "repo-finder", consolidate: "consolidate", check: "check", write: "write" } as const;
type Role = keyof typeof ROLE_FLAGS;
const ROLES = Object.keys(ROLE_FLAGS) as Role[];

/** The role that sets each agent's model. */
const ROLE_OF_AGENT: Record<string, Role | undefined> = {
  "code-review-plan": "plan",
  "code-review-finder": "diffFinder",
  "code-review-finder-repo": "repoFinder",
  "code-review-consolidate": "consolidate",
  "code-review-check": "check",
  "code-review-write": "write",
};

const STAGES = ["union", "consolidated", "confirmed", "final", "bothFinders", "oneFinder"] as const;
type Stage = (typeof STAGES)[number];

interface StepCost {
  model: string;
  usage: Usage;
  ms: number;
}

interface E2EResult {
  id: string;
  failed?: string;
  budgetExhausted?: boolean;
  wallMs: number;
  steps: Record<string, StepCost>;
  stages: Partial<Record<Stage, CaseScore & { findings: Finding[] }>>;
  outputs?: Record<string, unknown>;
}

interface E2EConfig {
  /** The roles whose model a flag overrides; every other step runs on its deployed model. */
  models: Partial<Record<Role, string>>;
  efforts: Record<Role, Effort>;
  budget?: number;
  check: boolean;
}

function effortFlag(value: unknown, fallback: Effort): Effort {
  if (value === undefined) return fallback;
  const effort = EFFORTS.find((e) => e === value);
  if (!effort) throw new Error(`effort must be one of ${EFFORTS.join(", ")}, got ${String(value)}`);
  return effort;
}

function e2eConfig(values: Record<string, unknown>): E2EConfig {
  function model(role: Role): [Role, string][] {
    const value = values[`${ROLE_FLAGS[role]}-model`];
    if (typeof value !== "string") return [];
    priceOf(value);
    return [[role, value]];
  }
  function effort(role: Role): [Role, Effort] {
    return [role, effortFlag(values[`${ROLE_FLAGS[role]}-effort`], role === "write" ? "low" : "medium")];
  }
  return {
    models: Object.fromEntries(ROLES.flatMap(model)),
    efforts: Object.fromEntries(ROLES.map(effort)) as Record<Role, Effort>,
    ...(typeof values.budget === "string" && { budget: Number(values.budget) }),
    check: values.check === true,
  };
}

function findingsAt(items: readonly Finding[]): Finding[] {
  return items.map(({ path, start, end, code }) => ({ path, start, end, ...(code !== undefined && { code }) }));
}

async function runE2ECase(testCase: Case, config: E2EConfig, source: Provider, github: typeof fetch): Promise<E2EResult> {
  const steps: Record<string, StepCost> = {};
  function stepOf(agentId: string, model: string): StepCost {
    return (steps[agentId] ??= { model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, ms: 0 });
  }
  function onEvent(event: InferenceEvent) {
    if (event.type !== "inference.done") return;
    const step = stepOf(event.data.source.sourceId, event.data.source.model);
    const { usage } = event.data;
    step.usage.input += usage.input;
    step.usage.output += usage.output;
    step.usage.cacheRead += usage.cacheRead;
    step.usage.cacheWrite += usage.cacheWrite;
    step.usage.costUsd += costOf(usage, priceOf(event.data.source.model));
  }
  function sourceFor(req: StepInvokeRequest) {
    const role = ROLE_OF_AGENT[req.agent.id];
    const model = (role && config.models[role]) ?? deployedModel(req.agent);
    stepOf(req.agent.id, model);
    return { id: req.agent.id, provider: "anthropic", baseURL: source.origin, credentialId: "inference", model };
  }
  function onStepDone(agentId: string, ms: number) {
    const step = steps[agentId];
    if (!step) throw new Error(`${agentId} finished without an inference source`);
    step.ms += ms;
  }
  const head = headOf(testCase.id);
  const request = { kind: "code-review", title: testCase.title, description: testCase.description, diff: testCase.diff, checkout: { source: "github", ...head }, efforts: config.efforts, check: config.check, ...(config.budget && { budgets: { repoFinder: config.budget } }) };
  const started = performance.now();
  const run = await runLocalWorkflow({
    workflow: prCodeReview({ sources: GITHUB }),
    directors: Object.values(directors),
    actions,
    credentialBindings: [{ handle: "github", package: githubRead.id }],
    authorize: allow,
    github,
    inference: { credentialId: "inference", origin: source.origin, apiKey: source.apiKey },
    sourceFor,
    triggerPayload: stockTriggerMail(request),
    onEvent,
    onStepDone,
  });
  const wallMs = Math.round(performance.now() - started);
  const outputs = run.outputs as Record<string, any>;
  const stages: E2EResult["stages"] = {};
  function score(stage: Stage, findings: Finding[]) {
    stages[stage] = { ...scoreCase(testCase, findings), findings };
  }
  if (outputs.candidates) score("union", reanchor(findingsAt(outputs.candidates.found), testCase.diff).findings);
  if (outputs.checks) score("consolidated", findingsAt(outputs.checks.findings));
  if (outputs.writeInput) score("confirmed", findingsAt(outputs.writeInput.findings));
  if (outputs.review) {
    const comments: (Finding & { agreement: { finders: number } })[] = outputs.review.comments;
    score("final", findingsAt(comments));
    score("bothFinders", findingsAt(comments.filter((c) => c.agreement.finders === 2)));
    score("oneFinder", findingsAt(comments.filter((c) => c.agreement.finders === 1)));
  }
  const failed = run.terminalStatus === "completed" ? undefined : `ended ${run.terminalStatus}`;
  return { id: testCase.id, ...(failed && { failed }), budgetExhausted: outputs.candidates?.budgetExhausted === true, wallMs, steps, stages, outputs };
}

function e2eStageRow(stage: Stage, results: readonly E2EResult[], keys: readonly CaseKey[]) {
  const scored = keys.filter((key) => results.some((r) => r.id === key.id));
  const bugs = scored.flatMap((key) => key.bugs.map((bug) => ({ ...bug, caseId: key.id })));
  function isCaught(bug: (typeof bugs)[number]): boolean {
    return results.some((r) => r.id === bug.caseId && r.stages[stage]?.caught.includes(bug.id));
  }
  function caughtOfReach(reach: Reach): [Reach, string] {
    const ofReach = bugs.filter((bug) => bug.reach === reach);
    return [reach, ratio(ofReach.filter(isCaught).length, ofReach.length)];
  }
  return {
    stage,
    bugsCaught: ratio(bugs.filter(isCaught).length, bugs.length),
    ...Object.fromEntries(REACHES.map(caughtOfReach)),
    findings: sum(results, (r) => r.stages[stage]?.findings.length ?? 0),
    falseAlarms: sum(results, (r) => r.stages[stage]?.falseAlarms ?? 0),
    cleanFlagged: ratio(results.filter((r) => r.stages[stage]?.flaggedClean).length, scored.filter((key) => key.kind === "clean").length),
  };
}

function e2eStepRows(results: readonly E2EResult[]) {
  const ids = [...new Set(results.flatMap((r) => Object.keys(r.steps)))];
  function row(id: string) {
    const all = results.flatMap((r) => (r.steps[id] ? [r.steps[id]] : []));
    return {
      step: id.replace("code-review-", ""),
      model: all[0]?.model,
      input: sum(all, (s) => s.usage.input),
      output: sum(all, (s) => s.usage.output),
      cacheRead: sum(all, (s) => s.usage.cacheRead),
      cacheWrite: sum(all, (s) => s.usage.cacheWrite),
      costUsd: Number(sum(all, (s) => s.usage.costUsd).toFixed(4)),
      seconds: Math.round(sum(all, (s) => s.ms) / 1000),
    };
  }
  return ids.map(row);
}

async function e2e(values: Record<string, unknown>) {
  const config = e2eConfig(values);
  const source = provider();
  const github = ghGithub();
  const cases = loadCases(typeof values.cases === "string" ? values.cases.split(",") : undefined);
  const results: E2EResult[] = [];
  for (const testCase of cases) {
    const result = await runE2ECase(testCase, config, source, github);
    results.push(result);
    const final = result.stages.final;
    console.error(`${result.id}: ${result.failed ?? "ok"} final ${final ? ratio(final.caught.length, testCase.bugs.length) : "-"}`);
  }
  const out = typeof values.out === "string" ? values.out : `e2e-${Date.now()}.results.json`;
  const stageRows = STAGES.map((stage) => e2eStageRow(stage, results, cases));
  const stepRows = e2eStepRows(results);
  writeFileSync(out, JSON.stringify({ config, origin: source.origin, stages: stageRows, steps: stepRows, results }, null, 2));
  console.table(
    results.map((r) => ({
      id: r.id,
      status: r.failed ?? "ok",
      ...Object.fromEntries(STAGES.map((stage) => [stage, r.stages[stage] ? `${r.stages[stage].caught.length} caught, ${r.stages[stage].falseAlarms} FA` : "-"])),
      seconds: Math.round(r.wallMs / 1000),
    })),
  );
  console.table(stageRows);
  console.table(stepRows);
  const exhausted = results.filter((r) => r.budgetExhausted).length;
  console.log(`total $${sum(stepRows, (r) => r.costUsd).toFixed(4)}, ${Math.round(sum(results, (r) => r.wallMs) / 1000)}s, ${exhausted} budget exhausted; results: ${out}`);
}


async function main() {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string" },
      effort: { type: "string", default: "medium" },
      model: { type: "string" },
      cases: { type: "string" },
      "max-tokens": { type: "string", default: "1000000" },
      out: { type: "string" },
      rescore: { type: "string" },
      repo: { type: "boolean", default: false },
      budget: { type: "string" },
      e2e: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      ...Object.fromEntries(Object.values(ROLE_FLAGS).flatMap((flag) => [[`${flag}-model`, { type: "string" }], [`${flag}-effort`, { type: "string" }]])),
    },
  });
  if (values.rescore) return rescore(values.rescore);
  if (values.e2e) return e2e(values);
  if (!values.prompt) throw new Error("--prompt <file.txt> is required");
  const effort = EFFORTS.find((e) => e === values.effort);
  if (!effort) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
  const maxTokens = Number(values["max-tokens"]);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error("--max-tokens must be a positive integer");
  const model = values.model ?? deployedModel(values.repo ? repoFinderAgent(GITHUB) : finderAgent());
  priceOf(model);
  const systemPrompt = readFileSync(values.prompt, "utf8");
  const source = provider();
  const repo = values.repo ? { github: ghGithub(), ...(values.budget && { budget: Number(values.budget) }) } : undefined;
  const cases = loadCases(values.cases?.split(","));
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const spent = sum(results, (r) => totalTokens(r.usage));
    if (spent > maxTokens) {
      console.error(`aborting: ${spent} tokens exceed --max-tokens ${maxTokens}`);
      break;
    }
    const result = await runCase(testCase, systemPrompt, effort, model, source, repo);
    results.push(result);
    const row = caseRow(result, testCase);
    console.error(`${result.id}: ${row.status} ${row.caught}`);
  }
  const run = { prompt: values.prompt, model, effort, repo: values.repo, origin: source.origin, summary: summary(results, cases), results };
  const out = values.out ?? `${basename(values.prompt, ".txt")}-${effort}-${Date.now()}.results.json`;
  writeFileSync(out, JSON.stringify(run, null, 2));
  console.table(results.map((result) => caseRow(result, keyOf(cases, result.id))));
  console.table([run.summary]);
  console.log(`results: ${out}`);
}

await main();
