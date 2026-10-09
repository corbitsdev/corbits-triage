import { describe, expect, test } from "bun:test";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState, ToolCall } from "@intx/types/runtime";
import type { WorkflowRunEvent, WorkflowRunReader } from "@intx/hub-sessions";
import { emptyPack, stockTriggerMail, type CheckPack, type PrTriageRow } from "@corbits/triage-contracts";
import { triageDirectorFactory } from "../../../../packages/triage-workflows/src/directors.js";
import { createTriageRuns } from "./triage-runs.js";
import { DEFAULT_RECONCILE_POLICY, planTenant, type ObservedRun } from "./reconcile-plan.js";

const REPO = "acme/widgets";
const DOMAIN = "acme.test";
const ANCHOR = "run_live";

type RenderOptions = { pack?: CheckPack; pr?: Record<string, unknown>; skipJudge?: boolean };

/** Drives the real facts and render directors for one batch mail and returns the render reply; `skipJudge` renders as the build that never asked the decision model did. */
async function batchRender(numbers: number[], failGetPr: Set<number>, { pack = emptyPack(REPO), pr = {}, skipJudge = false }: RenderOptions = {}): Promise<string> {
  const replies: string[] = [];
  const caps = {
    executeTools(calls: ToolCall[]) { return { type: "execute_tools", calls }; },
    reply(content: string) { replies.push(content); return { type: "reply", content }; },
  } as unknown as ReactorCapabilities;
  const facts = triageDirectorFactory({ role: "facts" }, {} as never, { systemPrompt: "" } as never);
  function done(callId: string, content: Record<string, unknown>, isError = false) {
    return facts.decide({ type: "tool.done", result: { callId, content, isError } } as ReactorInboundEvent, {} as ReactorState, caps);
  }
  const mail = { kind: "pr", repo: REPO, items: numbers.map((n) => ({ prNumber: n, headSha: `sha${n}` })), policy: { enabled: true }, checkPack: pack };
  await facts.decide({ type: "message.received", message: { content: JSON.stringify(mail) } } as ReactorInboundEvent, {} as ReactorState, caps);
  await done("github_list_open_prs", { prs: numbers.map((n) => ({ number: n, title: `PR ${n}` })) });
  for (const n of numbers) {
    if (failGetPr.has(n)) await done(`pr:${n}`, { error: "404" }, true);
    else await done(`pr:${n}`, { title: `PR ${n}`, author: "octocat", sha: `sha${n}`, state: "open", draft: false, mergeable: true, requestedReviewers: 0, ...pr });
    await done(`reviews:${n}`, { reviews: [] });
    await done(`commits:${n}`, { commits: [] });
    await done(`files:${n}`, { files: [] });
  }
  for (const n of numbers) if (!failGetPr.has(n)) await done(`checks:${n}`, { checks: [] });
  const render = triageDirectorFactory({ role: "render" }, {} as never, { systemPrompt: "" } as never);
  const factsReply = JSON.parse(replies[0]!) as { items: Array<{ det: { needsJudgment: boolean } }> };
  if (skipJudge) for (const item of factsReply.items) item.det.needsJudgment = false;
  await render.decide({ type: "message.received", message: { content: JSON.stringify(factsReply) } } as ReactorInboundEvent, {} as ReactorState, caps);
  return replies[1]!;
}

function events(numbers: number[], reply: string, at: string): WorkflowRunEvent[] {
  const payload = stockTriggerMail({ kind: "pr", repo: REPO, items: numbers.map((n) => ({ prNumber: n, headSha: `sha${n}` })) });
  return [
    { seq: 0, type: "RunStarted", body: { type: "RunStarted", seq: 0, at, trigger: { type: "mail", payload } } },
    { seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "render", output: { ref: `inline:${JSON.stringify({ reply })}` } } },
    { seq: 2, type: "RunCompleted", body: { type: "RunCompleted", seq: 2 } },
  ];
}

async function observe(numbers: number[], reply: string, runId = "run_batch", at = "2026-10-07T01:00:00.000Z") {
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
  const runs = await createTriageRuns({ runReader: reader, readSettled: async () => new Map(), maxKnownRuns: 100 })(ANCHOR, DOMAIN);
  return runs.byRepo.get(REPO)!;
}

describe("batch pairing through the real facts and render directors", () => {
  test("a pull request whose facts fail mid-batch degrades only its own head", async () => {
    const reply = await batchRender([1, 2, 3], new Set([2]));
    const byHead = await observe([1, 2, 3], reply);
    expect(byHead.get("1@sha1")![0]!.unsettled).toBeUndefined();
    expect(byHead.get("2@sha2")![0]!.unsettled).toContain("degraded");
    expect(byHead.get("3@sha3")![0]!.unsettled).toBeUndefined();
  });

  test("a render reply whose verdict count matches neither the heads nor one settles no head", async () => {
    const full = JSON.parse(await batchRender([1, 2, 3], new Set())) as { items: unknown[] };
    const dropped = JSON.stringify({ items: [full.items[0], full.items[2]] });
    const byHead = await observe([1, 2, 3], dropped);
    for (const n of [1, 2, 3]) expect(byHead.get(`${n}@sha${n}`)![0]!.unsettled).toBe("run completed without a verdict");
  });
});

describe("verdicts the decision model was never asked about", () => {
  const pack: CheckPack = { ...emptyPack(REPO), checks: { draft: { enabled: true }, conflicts: { enabled: true }, focused: { enabled: true } } };
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 7, 1, minute)).toISOString();

  function plan(rows: PrTriageRow[], runs: ObservedRun[], minute: number) {
    const byHead = new Map([["1@sha1", runs]]);
    const repos = [{ name: REPO, prs: [{ number: 1, headSha: "sha1", updatedAt: at(-60) }], rows }];
    return planTenant({ repos, runs: new Map([[REPO, byHead]]), now: new Date(at(minute)), policy: DEFAULT_RECONCILE_POLICY, workflowVersion: 1 }).get(REPO)!;
  }

  test("are triaged again once and settle on a verdict that asked", async () => {
    const skipped = (await observe([1], await batchRender([1], new Set(), { pack, pr: { draft: true }, skipJudge: true }), "run_old", at(0))).get("1@sha1")!;
    expect(skipped[0]!.unsettled).toBe("model not asked");
    const triaged: PrTriageRow = { number: 1, headSha: "sha1", status: "triaged", attempts: 0, runId: "run_old", workflowVersion: 1, firstSeenAt: at(-1), queuedAt: at(-1), updatedAt: at(1) };
    const redo = plan([triaged], skipped, 10);
    expect(redo.enqueue.map((queued) => queued.reason)).toEqual(["model not asked"]);
    const asked = (await observe([1], await batchRender([1], new Set(), { pack, pr: { draft: true } }), "run_new", at(11))).get("1@sha1")!;
    expect(asked[0]!.unsettled).toBeUndefined();
    const settled = plan(redo.rows, [...skipped, ...asked], 20);
    expect(settled.rows[0]).toMatchObject({ status: "triaged", runId: "run_new" });
    expect(plan(settled.rows, [...skipped, ...asked], 30).enqueue).toEqual([]);
  });

  test("are triaged again once even after the head spent its attempts", async () => {
    const skipped = (await observe([1], await batchRender([1], new Set(), { pack, pr: { draft: true }, skipJudge: true }), "run_old", at(0))).get("1@sha1")!;
    const capped: PrTriageRow = { number: 1, headSha: "sha1", status: "triaged", attempts: DEFAULT_RECONCILE_POLICY.maxAttempts, runId: "run_old", workflowVersion: 1, firstSeenAt: at(-1), queuedAt: at(-1), updatedAt: at(1) };
    const redo = plan([capped], skipped, 10);
    expect(redo.enqueue.map((queued) => queued.reason)).toEqual(["model not asked"]);
    expect(redo.rows[0]).toMatchObject({ status: "queued", attempts: 1 });
  });

  test("a stale-unknown verdict keeps its own reason", async () => {
    const reply = await batchRender([1], new Set(), { pack, pr: { mergeable: null } });
    const verdict = JSON.parse(reply).items[0] as { state: string; checks: Array<{ kind: string; reason: string }> };
    expect(verdict.state).toBe("stale-unknown");
    expect(verdict.checks.filter((check) => check.kind === "model").map((check) => check.reason)).toEqual(["not asked"]);
    const [run] = (await observe([1], reply)).get("1@sha1")!;
    expect(run).toMatchObject({ unsettled: "unconfirmed checks: conflicts", unconfirmed: true });
  });
});
