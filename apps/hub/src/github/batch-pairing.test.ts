import { describe, expect, test } from "bun:test";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState, ToolCall, ToolResult } from "@intx/types/runtime";
import type { WorkflowRunEvent, WorkflowRunReader } from "@intx/hub-sessions";
import { emptyPack, stockTriggerMail, type CheckPack, type PrTriageRow } from "@corbits/triage-contracts";
import { triageJudgeDirector } from "@corbits/triage-workflows/directors";
import { evaluate, parts, rules } from "@corbits/triage-workflows/actions/index";
import { readFacts } from "@corbits/triage-workflows/actions/facts";
import type { RulesOutput, JudgeChunk } from "@corbits/triage-workflows/actions/rules";
import { createTriageRuns } from "./triage-runs.js";
import type { CiState } from "@corbits/github-reads";
import { DEFAULT_RECONCILE_POLICY, planTenant, type ObservedRun } from "./reconcile-plan.js";
import { QUALITY_EVALUATION_LIMIT_ERROR } from "@corbits/triage-workflows/logic/quality";
import { NO_FACTS } from "@corbits/triage-workflows/logic/item";

const REPO = "acme/widgets";
const DOMAIN = "acme.test";
const ANCHOR = "run_live";

type VerdictOptions = { pack?: CheckPack; pr?: Record<string, unknown>; checks?: unknown[]; skipJudge?: boolean };

const ctx = {} as never;
const signal = new AbortController().signal;

function decisive(questions: Array<{ id: string }>): ReactorInboundEvent {
  const probabilities: Record<string, Record<string, number>> = {
    verdict: { pass: 0.9, fail: 0.05, cant_tell: 0.05 },
    focused: { one_thing: 0.9, more_than_one_thing: 0.05, cant_tell: 0.05 },
  };
  const text = questions.map(({ id }) => JSON.stringify(id === "instructed" ? { id, type: "noul", noul: 0.1 } : { id, type: "choice", choice: Object.keys(probabilities[id]!)[0], probabilities: probabilities[id], confidence: 0.9 })).join("");
  return { type: "inference.done", turn: { content: [{ type: "text", text }] } } as ReactorInboundEvent;
}

async function judge(chunks: JudgeChunk[], answer: (questions: Array<{ id: string }>) => ReactorInboundEvent): Promise<Array<{ reply: string }>> {
  const output: Array<{ reply: string }> = [];
  for (const chunk of chunks) {
    let reply = "";
    const caps = {
      infer() { return { type: "infer" }; },
      reply(content: string) { reply = content; return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageJudgeDirector.factory({}, {} as never, { systemPrompt: "" } as never);
    await director.decide({ type: "message.received", message: { content: JSON.stringify(chunk) } } as ReactorInboundEvent, {} as ReactorState, caps);
    await director.decide(answer(chunk.questions), {} as ReactorState, caps);
    output.push({ reply });
  }
  return output;
}

async function judgeAndEvaluate(ruled: RulesOutput, first: (questions: Array<{ id: string }>) => ReactorInboundEvent = decisive) {
  if (!ruled.needsJudgment) return { output: undefined, reply: JSON.stringify(await evaluate(ruled, ctx, signal)) };
  const output = await judge(ruled.chunks, first);
  const judged = { ...ruled, judge: { output } };
  const { chunks } = await parts(judged, ctx, signal);
  return { output, reply: JSON.stringify(await evaluate({ ...judged, judgeParts: { output: await judge(chunks, decisive) } }, ctx, signal)) };
}

/** GitHub answering each call by its id, failing those `failed` names. */
function github(results: Record<string, unknown>, failed: ReadonlySet<string> = new Set()) {
  return async function host(asked: ToolCall): Promise<ToolResult> {
    return failed.has(asked.id) ? { callId: asked.id, content: "404", isError: true } : { callId: asked.id, content: results[asked.id] as Record<string, unknown> };
  };
}

/** Drives the real facts, rules and evaluate actions for one batch mail and returns the verdict output; `skipJudge` evaluates as the build that never asked the decision model did. */
async function batchVerdicts(numbers: number[], failGetPr: Set<number>, { pack = emptyPack(REPO), pr = {}, checks = [], skipJudge = false }: VerdictOptions = {}): Promise<string> {
  const results: Record<string, unknown> = {
    github_list_open_prs: { prs: numbers.map((n) => ({ number: n, title: `PR ${n}` })) },
    "docs:0": { docs: [], rules: [], ref: "tree" },
  };
  for (const n of numbers) {
    results[`pr:${n}`] = { title: `PR ${n}`, author: "octocat", sha: `sha${n}`, state: "open", draft: false, mergeable: true, requestedReviewers: 0, ...pr };
    results[`reviews:${n}`] = { reviews: [] };
    results[`comments:${n}`] = { comments: [] };
    results[`commits:${n}`] = { commits: [] };
    results[`files:${n}:0`] = { files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }] };
    results[`stack:${n}`] = { includes: [] };
    results[`checks:${n}`] = { checks };
  }
  const failed = new Set([...failGetPr].map((n) => `pr:${n}`));
  const mail = { kind: "pr", repo: REPO, items: numbers.map((n) => ({ prNumber: n, headSha: `sha${n}` })), policy: { enabled: true }, checkPack: pack };
  const ruled = await rules(await readFacts(mail, () => github(results, failed)), ctx, signal);
  if (!skipJudge) return (await judgeAndEvaluate(ruled)).reply;
  for (const item of ruled.items) item.det.needsJudgment = false;
  return JSON.stringify(await evaluate(ruled, ctx, signal));
}

function events(numbers: number[], output: string, at: string): WorkflowRunEvent[] {
  const payload = stockTriggerMail({ kind: "pr", repo: REPO, items: numbers.map((n) => ({ prNumber: n, headSha: `sha${n}` })) });
  return [
    { seq: 0, type: "RunStarted", body: { type: "RunStarted", seq: 0, at, trigger: { type: "mail", payload } } },
    { seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, at, stepId: "evaluate", output: { ref: `inline:${output}` } } },
    { seq: 2, type: "RunCompleted", body: { type: "RunCompleted", seq: 2 } },
  ];
}

async function observe(numbers: number[], reply: string, runId = "run_batch", at = "2026-10-07T01:00:00.000Z") {
  return (await observeRuns(numbers, reply, runId, at)).byRepo.get(REPO)!;
}

async function observeRuns(numbers: number[], reply: string, runId: string, at: string) {
  const log = events(numbers, reply, at);
  const reader = {
    async listRunIds() { return [runId]; },
    async readRunEvents() { return log; },
    async readLatestRunEvents(_repo: unknown, _ref: string, include: (id: string) => boolean) {
      return { tip: "t", events: new Map(include(runId) ? [[runId, log.at(-1)!]] : []) };
    },
    async resolveRefTip() { return "t"; },
    async hasRepository() { return true; },
  } as unknown as WorkflowRunReader;
  return createTriageRuns({ runReader: reader, readSettled: async () => new Map(), maxKnownRuns: 100 })(ANCHOR, DOMAIN);
}

describe("batch pairing through the real facts and evaluate actions", () => {
  test("a pull request whose facts fail mid-batch degrades only its own head", async () => {
    const reply = await batchVerdicts([1, 2, 3], new Set([2]));
    const byHead = await observe([1, 2, 3], reply);
    expect(byHead.get("1@sha1")![0]!.unsettled).toBeUndefined();
    expect(byHead.get("2@sha2")![0]!.unsettled).toContain("degraded");
    expect(byHead.get("3@sha3")![0]!.unsettled).toBeUndefined();
  });

  test("a verdict output whose count matches neither the heads nor one settles no head", async () => {
    const full = JSON.parse(await batchVerdicts([1, 2, 3], new Set())) as { items: unknown[] };
    const dropped = JSON.stringify({ items: [full.items[0], full.items[2]] });
    const byHead = await observe([1, 2, 3], dropped);
    for (const n of [1, 2, 3]) expect(byHead.get(`${n}@sha${n}`)![0]!.unsettled).toBe("run completed without a verdict");
  });
});

describe("a backlog run", () => {
  test("records a verdict for every pull request it could read, from a mail that names none", async () => {
    const results: Record<string, unknown> = {
      github_list_open_prs: { prs: [{ number: 3 }, { number: 2 }] },
      "pr:2": { title: "PR 2", author: "octocat", sha: "sha2", state: "open", draft: false, mergeable: true, requestedReviewers: 0 },
      "checks:2": { checks: [] },
    };
    for (const n of [3, 2]) {
      results[`reviews:${n}`] = { reviews: [] };
      results[`comments:${n}`] = { comments: [] };
      results[`commits:${n}`] = { commits: [] };
      results[`files:${n}:0`] = { files: [] };
    }
    const mail = { kind: "backlog", repo: REPO, policy: { enabled: true }, checkPack: emptyPack(REPO) };
    const ruled = await rules(await readFacts(mail, () => github(results, new Set(["pr:3"]))), ctx, signal);
    const evaluated = await evaluate(ruled, ctx, signal);
    const at = "2026-10-07T01:00:00.000Z";
    const log: WorkflowRunEvent[] = [
      { seq: 0, type: "RunStarted", body: { type: "RunStarted", seq: 0, at, trigger: { type: "mail", payload: stockTriggerMail({ kind: "backlog", repo: REPO }) } } },
      { seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "rules", output: { ref: `inline:${JSON.stringify(ruled)}` } } },
      { seq: 2, type: "StepCompleted", body: { type: "StepCompleted", seq: 2, at, stepId: "evaluateRules", output: { ref: `inline:${JSON.stringify(evaluated)}` } } },
    ];
    let read = log.slice(0, 1);
    const reader = {
      async readRunEvents() { return read; },
      async readLatestRunEvents(_repo: unknown, _ref: string, include: (id: string) => boolean) {
        return { tip: "t", events: new Map(include("run_backlog") ? [["run_backlog", read.at(-1)!]] : []) };
      },
    } as unknown as WorkflowRunReader;
    const observeRuns = createTriageRuns({ runReader: reader, readSettled: async () => new Map(), maxKnownRuns: 100 });
    expect((await observeRuns(ANCHOR, DOMAIN)).verdicts).toEqual([]);
    read = log;
    const { verdicts } = await observeRuns(ANCHOR, DOMAIN);
    expect(verdicts.map(({ number, headSha, state, detail }) => ({ number, headSha, state, reason: detail?.reason }))).toEqual([
      { number: 2, headSha: "sha2", state: "ready-monitoring", reason: "every rule passed, and the policy has no decision-model rule" },
    ]);
  });
});

describe("verdicts the decision model was never asked about", () => {
  const pack: CheckPack = { ...emptyPack(REPO), checks: { "no-merge-conflicts": { enabled: true }, focused: { enabled: true } } };
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 7, 1, minute)).toISOString();

  // The hub stamps each run with its deployment's version as it reads the log.
  const VERSION = "0.1.0-sha-1";

  function plan(rows: PrTriageRow[], runs: ObservedRun[], minute: number) {
    const byHead = new Map([["1@sha1", runs.map((run) => ({ ...run, workflowVersion: VERSION }))]]);
    const repos = [{ name: REPO, prs: [{ number: 1, headSha: "sha1", updatedAt: at(-60), draft: false }], rows }];
    return planTenant({ repos, runs: new Map([[REPO, byHead]]), now: new Date(at(minute)), policy: DEFAULT_RECONCILE_POLICY, workflowVersion: VERSION }).get(REPO)!;
  }

  test("are triaged again once and settle on a verdict that asked", async () => {
    const skipped = (await observe([1], await batchVerdicts([1], new Set(), { pack, skipJudge: true }), "run_old", at(0))).get("1@sha1")!;
    expect(skipped[0]!.unsettled).toBe("model not asked");
    const triaged: PrTriageRow = { number: 1, headSha: "sha1", status: "triaged", attempts: 0, runId: "run_old", workflowVersion: VERSION, firstSeenAt: at(-1), queuedAt: at(-1), updatedAt: at(1) };
    const redo = plan([triaged], skipped, 10);
    expect(redo.enqueue.map((queued) => queued.reason)).toEqual(["model not asked"]);
    const asked = (await observe([1], await batchVerdicts([1], new Set(), { pack }), "run_new", at(11))).get("1@sha1")!;
    expect(asked[0]!.unsettled).toBeUndefined();
    const settled = plan(redo.rows, [...skipped, ...asked], 20);
    expect(settled.rows[0]).toMatchObject({ status: "triaged", runId: "run_new" });
    expect(plan(settled.rows, [...skipped, ...asked], 30).enqueue).toEqual([]);
  });

  test("are triaged again once even after the head spent its attempts", async () => {
    const skipped = (await observe([1], await batchVerdicts([1], new Set(), { pack, skipJudge: true }), "run_old", at(0))).get("1@sha1")!;
    const capped: PrTriageRow = { number: 1, headSha: "sha1", status: "triaged", attempts: DEFAULT_RECONCILE_POLICY.maxAttempts, runId: "run_old", workflowVersion: VERSION, firstSeenAt: at(-1), queuedAt: at(-1), updatedAt: at(1) };
    const redo = plan([capped], skipped, 10);
    expect(redo.enqueue.map((queued) => queued.reason)).toEqual(["model not asked"]);
    expect(redo.rows[0]).toMatchObject({ status: "queued", attempts: 1 });
  });

  test("unknown mergeability keeps its own reason though the judge was asked", async () => {
    const reply = await batchVerdicts([1], new Set(), { pack, pr: { mergeable: null } });
    const verdict = JSON.parse(reply).items[0] as { verdict: string; checks: Array<{ kind: string; result: string }> };
    expect(verdict.verdict).toBe("unsure");
    expect(verdict.checks.filter((check) => check.kind === "model").map((check) => check.result)).toEqual(["pass"]);
    const [run] = (await observe([1], reply)).get("1@sha1")!;
    expect(run).toMatchObject({ unsettled: "unconfirmed checks: no-merge-conflicts", unconfirmed: true });
  });

  test("deterministic and ambiguous human gates settle while a real inference outage requeues", async () => {
    const pack: CheckPack = { ...emptyPack(REPO), checks: { focused: { enabled: true } } };
    function facts(files: Array<{ path: string; patch?: string }>) {
      return { ...NO_FACTS, repo: REPO, number: 1, title: "Change", author: "octocat", headSha: "sha1", mergeable: true, checks: "success", files, paths: files.map((file) => file.path) };
    }
    async function triage(files: Array<{ path: string; patch?: string }>, event?: ReactorInboundEvent) {
      const ruled = await rules({ items: [{ facts: facts(files), pack }], batch: true }, ctx, signal);
      const { output, reply } = await judgeAndEvaluate(ruled, () => event!);
      return { ruled, judged: output?.map((chunk) => JSON.parse(chunk.reply) as Record<string, unknown>), reply };
    }

    const compact = [{ path: "src/config.ts", patch: '@@ -0,0 +1 @@\n+const value = { name: "Candidate" };' }];
    const wide = Array.from({ length: 20 }, (_, index) => `@@ -${index + 1} +${index + 1} @@\n+// ${"設".repeat(3_000)}`).join("\n");
    const oversized = Array.from({ length: 40 }, (_, index) => ({ path: `src/wide${index}.ts`, patch: wide }));
    const local = await triage(oversized);
    const provider = await triage(compact, { type: "inference.error", error: { message: QUALITY_EVALUATION_LIMIT_ERROR } } as ReactorInboundEvent);
    const ambiguousDecision = JSON.stringify({
      id: "focused", type: "choice", choice: "cant_tell", confidence: 0.9,
      probabilities: { one_thing: 0.05, more_than_one_thing: 0.05, cant_tell: 0.9 },
    }) + JSON.stringify({ id: "instructed", type: "noul", noul: 0.1 });
    const ambiguousResult = await triage(compact, { type: "inference.done", turn: { content: [{ type: "text", text: ambiguousDecision }] } } as ReactorInboundEvent);
    expect(local.judged).toBeUndefined();
    expect(local.ruled.items[0]).toMatchObject({ judgeError: expect.stringMatching(/^pull request too large for the decision model \(\d+ requests\)$/), judgeLimitExceeded: true });
    expect(provider.judged).toEqual([{ judgeError: QUALITY_EVALUATION_LIMIT_ERROR }]);

    const deterministic = (await observe([1], local.reply, "run_limit", at(0))).get("1@sha1")!;
    const ambiguous = (await observe([1], ambiguousResult.reply, "run_ambiguous", at(0))).get("1@sha1")!;
    const outage = (await observe([1], provider.reply, "run_outage", at(0))).get("1@sha1")!;

    expect(deterministic[0]?.unsettled).toBeUndefined();
    expect(ambiguous[0]?.unsettled).toBeUndefined();
    expect(plan([], deterministic, 10).enqueue).toEqual([]);
    expect(plan([], ambiguous, 10).enqueue).toEqual([]);
    expect(outage[0]?.unsettled).toBe(`degraded: decision model unavailable: ${QUALITY_EVALUATION_LIMIT_ERROR}`);
    expect(plan([], outage, 10).enqueue.map((queued) => queued.reason)).toEqual([`degraded: decision model unavailable: ${QUALITY_EVALUATION_LIMIT_ERROR}`]);
  });
});

describe("a head CI is still running on", () => {
  const pack: CheckPack = { ...emptyPack(REPO), checks: { "ci-green": { enabled: true } } };
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 7, 1, minute)).toISOString();

  function plan(rows: PrTriageRow[], runs: ObservedRun[], ci: CiState, minute: number) {
    const repos = [{ name: REPO, prs: [{ number: 1, headSha: "sha1", updatedAt: at(-60), draft: false }], rows, ci: new Map([["1@sha1", ci]]) }];
    return planTenant({ repos, runs: new Map([[REPO, new Map([["1@sha1", runs]])]]), now: new Date(at(minute)), policy: DEFAULT_RECONCILE_POLICY, workflowVersion: undefined }).get(REPO)!;
  }

  test("records no verdict and waits for CI, then is triaged once CI finishes and records the pass", async () => {
    const held = await observeRuns([1], await batchVerdicts([1], new Set(), { pack, checks: [{ name: "build", status: "in_progress", conclusion: null }] }), "run_held", at(0));
    expect(held.verdicts).toEqual([]);
    const runs = held.byRepo.get(REPO)!.get("1@sha1")!;
    expect(runs).toMatchObject([{ status: "completed", heldForCi: true }]);
    const running: PrTriageRow = { number: 1, headSha: "sha1", status: "running", attempts: 1, runId: "run_held", firstSeenAt: at(-1), queuedAt: at(-1), updatedAt: at(0), events: ["ready"] };
    const waiting = plan([running], runs, "pending", 2);
    expect(waiting.rows[0]).toMatchObject({ status: "waiting", events: ["ready"] });
    expect(waiting.enqueue).toEqual([]);
    expect(plan(waiting.rows, runs, "success", 4).enqueue).toEqual([{ number: 1, reason: "waited for CI", events: ["ready"] }]);
    const passed = await observeRuns([1], await batchVerdicts([1], new Set(), { pack, checks: [{ name: "build", status: "completed", conclusion: "success" }] }), "run_pass", at(5));
    expect(passed.verdicts).toMatchObject([{ number: 1, headSha: "sha1", detail: { verdict: "pass" } }]);
  });

  test("a closed pull request records no verdict", async () => {
    const closed = await observeRuns([1], await batchVerdicts([1], new Set(), { pr: { state: "closed" } }), "run_closed", at(0));
    expect(closed.verdicts).toEqual([]);
  });
});
