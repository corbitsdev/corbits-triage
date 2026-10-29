// Finder eval: runs the pr-code-review definition with any finder system prompt over the cases in evals/labels/ and
// scores the findings against each case's answer key (score.ts): a bug is caught once, by the first finding on its path
// that overlaps any of its sites within three lines; a later finding that hits only caught bugs is a false alarm; a
// finding that hits no bug uses up one ignored item it hits (a true finding that is not a bug) and is neither, else it is
// a false alarm. A finding with a `code` line is first moved onto that line in the diff. Writes a results JSON beside
// the table.
//
//   bun run eval:review -- --prompt <file.txt> --effort medium [--model claude-haiku-5-5] [--repo] [--cases a,b] [--max-tokens 1000000] [--out <file.json>]
//   --repo checks each case's head out (with `gh auth token`) and lets the finder read it; every tool call is recorded.
//   --budget <tokens> sets the repository finder's token budget (default the workflow's).
//   bun run eval:review -- --rescore <results-dir>   re-scores saved results without model calls
//   bun run eval:review -- --rescore <e2e.json> [--out <file.json>]   sweeps posting cutoffs over a saved --e2e run without
//   model calls (sweep.ts) and reports the loosest one at 85% precision and the precision/recall frontier.
//   bun run eval:review -- --e2e [--cases a,b] [--<role>-model m] [--<role>-effort e] [--budget n] [--out <file.json>] [--baseline]
//   with <role> one of plan, diff-finder, repo-finder, consolidate, check, write; each role defaults to its deployed model;
//   runs the whole pr-code-review workflow on each case's head, checking every finding as every review does, and
//   scores the finders' union, the consolidated findings (what the review posted before the check), the ones the check
//   confirmed, the final review, and its comments found by both finders and by one, with each stage's precision and
//   each step's tokens, dollars and seconds. --baseline, over every case, also writes
//   results/pr-code-review.baseline.json, refusing on a dirty working tree or when any case's repository is not public.
//
// Inference is native Anthropic when ANTHROPIC_API_KEY is set, else OpenCode Zen with OPENCODE_API_KEY.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import type { InferenceEvent } from "@intx/types/inference-events";
import type { AgentDefinition } from "@intx/agent";
import type { StepInvokeRequest, WorkflowAuthorizeFn } from "@intx/workflow";
import { stockTriggerMail } from "@corbits/triage-contracts";
import { startBaseline, writeBaseline, type Stamp } from "../../triage-workflows/evals/baseline.js";
import { addCost, costOf, priceKey, priceOf, type ProviderId } from "../../triage-workflows/evals/prices.js";
import { runLocalWorkflow } from "../../triage-workflows/src/run-local.js";
import * as actions from "../src/actions/index.js";
import { BUDGET_EXHAUSTED } from "@corbits/pr-code-review/actions/checkout";
import { credentialBindingsFor } from "@corbits/pr-code-review/agents";
import { finderAgent, repoFinderAgent, type Sources } from "../src/agents.js";
import * as directors from "../src/directors.js";
import { prCodeReview } from "../src/pr-code-review.js";
import { finderInput } from "./finder-input.js";
import { prCodeFinder } from "./finder-workflow.js";
import { headOf, loadCases, loadKeys, pullRequestOf, type Case, type CaseKey, type Reach } from "./cases.js";
import { parseFindings, REACHES, reanchor, scoreCase, type CaseScore, type Finding } from "./score.js";
import { commentsOf, cutoffs, frontier, KEEP_ALL, loosest, scoreCutoff, type Cutoff, type Replayed, type SavedOutputs, type SweepRow } from "./sweep.js";

// The cases are GitHub pull requests.
const GITHUB: Sources = ["github"];

// Heads are checked out under a throwaway folder, named as the sidecar names its data dir.
const DATA_DIR = mkdtempSync(join(tmpdir(), "code-review-eval-"));
process.env.SIDECAR_DATA_DIR = DATA_DIR;

const EFFORTS = ["low", "medium", "high"] as const;
type Effort = (typeof EFFORTS)[number];

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Null once a call used tokens at a rate the price table does not know. */
  costUsd: number | null;
}

interface Provider {
  id: ProviderId;
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
  if (anthropic) return { id: "anthropic", origin: "https://api.anthropic.com", apiKey: anthropic };
  const zen = process.env.OPENCODE_API_KEY;
  if (zen) return { id: "opencode-zen", origin: "https://opencode.ai/zen", apiKey: zen };
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

/** How a case's finder reaches GitHub: not at all, or reading the case's head on an optional token budget. */
type RepoAccess = { github: typeof fetch; budget?: number } | undefined;

async function runCase(testCase: Case, systemPrompt: string, effort: Effort, model: string, source: Provider, repo: RepoAccess): Promise<CaseResult> {
  const price = priceOf(priceKey(source.id, model));
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
    usage.costUsd = addCost(usage.costUsd, costOf(event.data.usage, price));
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
    credentialBindings: repo ? credentialBindingsFor(GITHUB) : [],
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

function sum<T>(results: readonly T[], pick: (result: T) => number): number {
  return results.reduce((total, result) => total + pick(result), 0);
}

function totalCost(costs: readonly (number | null)[]): number | null {
  return costs.reduce<number | null>((total, cost) => addCost(total, cost), 0);
}

function dollars(cost: number | null): number | null {
  return cost === null ? null : Number(cost.toFixed(4));
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
    costUsd: totalCost(results.map((r) => r.usage.costUsd)),
  };
  return {
    cases: results.length,
    bugsCaught: ratio(bugs.filter(isCaught).length, bugs.length),
    ...Object.fromEntries(REACHES.map(caughtOfReach)),
    falseAlarms: sum(results, (r) => r.falseAlarms ?? 0),
    ignored: sum(results, (r) => r.ignored ?? 0),
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
    costUsd: dollars(usage.costUsd),
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

function rescore(dir: string, out: string | undefined) {
  if (statSync(dir).isFile()) return sweep(dir, out);
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
}

function effortFlag(value: unknown, fallback: Effort): Effort {
  if (value === undefined) return fallback;
  const effort = EFFORTS.find((e) => e === value);
  if (!effort) throw new Error(`effort must be one of ${EFFORTS.join(", ")}, got ${String(value)}`);
  return effort;
}

function e2eConfig(values: Record<string, unknown>, provider: ProviderId): E2EConfig {
  function model(role: Role): [Role, string][] {
    const value = values[`${ROLE_FLAGS[role]}-model`];
    if (typeof value !== "string") return [];
    priceOf(priceKey(provider, value));
    return [[role, value]];
  }
  function effort(role: Role): [Role, Effort] {
    return [role, effortFlag(values[`${ROLE_FLAGS[role]}-effort`], role === "write" ? "low" : "medium")];
  }
  return {
    models: Object.fromEntries(ROLES.flatMap(model)),
    efforts: Object.fromEntries(ROLES.map(effort)) as Record<Role, Effort>,
    ...(typeof values.budget === "string" && { budget: Number(values.budget) }),
  };
}

function findingsAt(items: readonly Finding[]): Finding[] {
  return items.map(({ path, start, end, priority, code }) => ({ path, start, end, priority, ...(code !== undefined && { code }) }));
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
    step.usage.costUsd = addCost(step.usage.costUsd, costOf(usage, priceOf(priceKey(source.id, event.data.source.model))));
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
  const request = { kind: "code-review", title: testCase.title, description: testCase.description, diff: testCase.diff, checkout: { source: "github", ...head }, efforts: config.efforts, ...(config.budget && { budgets: { repoFinder: config.budget } }) };
  const started = performance.now();
  const run = await runLocalWorkflow({
    workflow: prCodeReview({ sources: GITHUB }),
    directors: Object.values(directors),
    actions,
    credentialBindings: credentialBindingsFor(GITHUB),
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

const PRECISION_BAR = 0.85;

/** A saved case's comments with their features; keeping all of them must score as the saved final review did, and each must carry a confidence. */
function replayedOf(result: E2EResult, key: CaseKey): Replayed {
  if (result.failed !== undefined || !result.outputs) throw new Error(`${result.id}: the saved run has no complete review to replay`);
  const comments = commentsOf(result.outputs as unknown as SavedOutputs);
  const all = scoreCase(key, comments);
  const saved = result.stages.final;
  if (!saved || all.falseAlarms !== saved.falseAlarms || all.caught.join() !== saved.caught.join()) throw new Error(`${result.id}: keeping every comment does not score as the saved final review`);
  const blind = comments.find((c) => c.confidence === undefined);
  if (blind) throw new Error(`${result.id}: the comment at ${blind.path}:${blind.start} carries no finder confidence`);
  return { key, comments };
}

function cutoffLabel({ oneFinder, bothFinders, priority }: Cutoff): string {
  function least(value: number): string {
    return value === Number.POSITIVE_INFINITY ? "none" : `>=${value}`;
  }
  return `one ${least(oneFinder)}, both ${least(bothFinders)}, p<=${priority === Number.POSITIVE_INFINITY ? "any" : priority}`;
}

function percent(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function sweepRow(row: SweepRow) {
  return {
    cutoff: cutoffLabel(row.cutoff),
    precision: percent(row.precision),
    recall: `${row.caught}/${row.bugs} ${percent(row.recall)}`,
    ...row.byReach,
    falseAlarms: row.falseAlarms,
    cleanSilent: `${row.cleanSilent}/${row.clean}`,
    perPr: row.commentsPerPr.toFixed(2),
    prsCommented: `${row.prsCommented}/${row.cases}`,
  };
}

function sweep(file: string, out: string | undefined) {
  const run = JSON.parse(readFileSync(file, "utf8")) as { stages?: unknown; results: E2EResult[] };
  if (run.stages === undefined) throw new Error(`${file} is not --e2e output`);
  const keys = loadKeys();
  const replayed = run.results.map((result) => replayedOf(result, keyOf(keys, result.id)));
  const rows = cutoffs(replayed).map((cutoff) => scoreCutoff(replayed, cutoff));
  const all = scoreCutoff(replayed, KEEP_ALL);
  const chosen = loosest(rows, PRECISION_BAR);
  const best = frontier(rows);
  console.table([all].map(sweepRow));
  console.table(best.map(sweepRow));
  console.log(chosen ? `loosest at ${percent(PRECISION_BAR)} precision: ${cutoffLabel(chosen.cutoff)}` : `no cutoff reaches ${percent(PRECISION_BAR)} precision`);
  if (chosen) console.table([chosen].map(sweepRow));
  function labelled(row: SweepRow) {
    return { label: cutoffLabel(row.cutoff), ...row };
  }
  if (out) writeFileSync(out, JSON.stringify({ file, bar: PRECISION_BAR, keepAll: labelled(all), chosen: chosen && labelled(chosen), frontier: best.map(labelled), rows: rows.map(labelled) }, null, 2));
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
  const findings = sum(results, (r) => r.stages[stage]?.findings.length ?? 0);
  const falseAlarms = sum(results, (r) => r.stages[stage]?.falseAlarms ?? 0);
  const ignored = sum(results, (r) => r.stages[stage]?.ignored ?? 0);
  const judged = findings - ignored;
  return {
    stage,
    bugsCaught: ratio(bugs.filter(isCaught).length, bugs.length),
    ...Object.fromEntries(REACHES.map(caughtOfReach)),
    findings,
    falseAlarms,
    ignored,
    precision: percent(judged === 0 ? null : (judged - falseAlarms) / judged),
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
      costUsd: dollars(totalCost(all.map((s) => s.usage.costUsd))),
      seconds: Math.round(sum(all, (s) => s.ms) / 1000),
    };
  }
  return ids.map(row);
}

const BASELINE = new URL("./results/pr-code-review.baseline.json", import.meta.url).pathname;

function stageTotals(stage: Stage, results: readonly E2EResult[], keys: readonly CaseKey[]): [Stage, Record<string, number>] {
  const scored = keys.filter((key) => results.some((r) => r.id === key.id));
  return [stage, {
    caught: sum(results, (r) => r.stages[stage]?.caught.length ?? 0),
    bugs: sum(scored, (key) => key.bugs.length),
    findings: sum(results, (r) => r.stages[stage]?.findings.length ?? 0),
    falseAlarms: sum(results, (r) => r.stages[stage]?.falseAlarms ?? 0),
    ignored: sum(results, (r) => r.stages[stage]?.ignored ?? 0),
    cleanFlagged: results.filter((r) => r.stages[stage]?.flaggedClean).length,
    clean: scored.filter((key) => key.kind === "clean").length,
  }];
}

/** The final review's comments where they sit, each with the bug it caught; their text stays out of the baseline. */
function baselineCase(result: E2EResult, key: CaseKey) {
  const final = result.stages.final;
  const caught = final?.caught ?? [];
  const review = result.outputs?.review as { comments: (Finding & { priority?: number })[] } | undefined;
  function placed(comment: Finding & { priority?: number }, index: number) {
    const outcome = final?.outcomes[index];
    return { path: comment.path, line: comment.start, ...(comment.priority !== undefined && { priority: comment.priority }), ...(outcome?.kind === "caught" && { bug: outcome.bug }) };
  }
  return {
    id: result.id,
    failed: result.failed !== undefined,
    caught,
    missed: key.bugs.map((bug) => bug.id).filter((id) => !caught.includes(id)),
    findings: (review?.comments ?? []).map(placed),
  };
}

function writeE2EBaseline(results: readonly E2EResult[], keys: readonly CaseKey[], source: Provider, stamp: Stamp) {
  const all = results.flatMap((r) => Object.entries(r.steps));
  const usage: Record<string, Usage> = {};
  for (const [, step] of all) {
    const total = (usage[priceKey(source.id, step.model)] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
    total.input += step.usage.input;
    total.output += step.usage.output;
    total.cacheRead += step.usage.cacheRead;
    total.cacheWrite += step.usage.cacheWrite;
    total.costUsd = addCost(total.costUsd, step.usage.costUsd);
  }
  writeBaseline(BASELINE, {
    workflow: "pr-code-review",
    eval: "review",
    steps: Object.fromEntries(all.map(([id, step]) => [id, { provider: source.id, model: step.model }])),
    usage: Object.fromEntries(Object.entries(usage).map(([key, u]) => [key, { ...u, costUsd: dollars(u.costUsd) }])),
    cases: results.map((result) => baselineCase(result, keyOf(keys, result.id))),
    totals: Object.fromEntries(STAGES.map((stage) => stageTotals(stage, results, keys))),
  }, stamp);
  console.log(`baseline: ${BASELINE}`);
}

async function e2e(values: Record<string, unknown>) {
  if (values.baseline && values.cases) throw new Error("--baseline runs every case; drop --cases");
  const source = provider();
  const config = e2eConfig(values, source.id);
  const github = ghGithub();
  const cases = loadCases(typeof values.cases === "string" ? values.cases.split(",") : undefined);
  const stamp = values.baseline ? startBaseline(cases.map((c) => headOf(c.id).repo)) : undefined;
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
  const cost = totalCost(stepRows.map((r) => r.costUsd));
  const [, final] = stageTotals("final", results, cases);
  console.log(`score: final review caught ${ratio(final.caught, final.bugs)} bugs (${percent(final.bugs === 0 ? null : final.caught / final.bugs)}), ${final.falseAlarms} false alarms, ${final.ignored} on true findings that are not bugs`);
  console.log(`total ${cost === null ? "price unknown" : `$${cost.toFixed(4)}`}, ${Math.round(sum(results, (r) => r.wallMs) / 1000)}s, ${exhausted} budget exhausted; results: ${out}`);
  if (stamp) writeE2EBaseline(results, cases, source, stamp);
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
      baseline: { type: "boolean", default: false },
      ...Object.fromEntries(Object.values(ROLE_FLAGS).flatMap((flag) => [[`${flag}-model`, { type: "string" }], [`${flag}-effort`, { type: "string" }]])),
    },
  });
  if (values.rescore) return rescore(values.rescore, values.out);
  if (values.e2e) return e2e(values);
  if (values.baseline) throw new Error("--baseline needs --e2e");
  if (!values.prompt) throw new Error("--prompt <file.txt> is required");
  const effort = EFFORTS.find((e) => e === values.effort);
  if (!effort) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
  const maxTokens = Number(values["max-tokens"]);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error("--max-tokens must be a positive integer");
  const model = values.model ?? deployedModel(values.repo ? repoFinderAgent() : finderAgent());
  const source = provider();
  priceOf(priceKey(source.id, model));
  const systemPrompt = readFileSync(values.prompt, "utf8");
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

try {
  await main();
} finally {
  rmSync(DATA_DIR, { recursive: true, force: true });
}
