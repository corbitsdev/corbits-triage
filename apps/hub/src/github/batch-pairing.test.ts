import { describe, expect, test } from "bun:test";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState, ToolCall } from "@intx/types/runtime";
import type { WorkflowRunEvent, WorkflowRunReader } from "@intx/hub-sessions";
import { emptyPack } from "@corbits/triage-contracts";
import { triageDirectorFactory } from "../../../../packages/triage-workflows/src/directors.js";
import { createTriageRuns } from "./triage-runs.js";

const REPO = "acme/widgets";
const DOMAIN = "acme.test";
const ANCHOR = "run_live";

/** Drives the real facts and render directors for one batch mail and returns the render reply. */
async function batchRender(numbers: number[], failGetPr: Set<number>): Promise<string> {
  const replies: string[] = [];
  const caps = {
    executeTools(calls: ToolCall[]) { return { type: "execute_tools", calls }; },
    reply(content: string) { replies.push(content); return { type: "reply", content }; },
  } as unknown as ReactorCapabilities;
  const facts = triageDirectorFactory({ role: "facts" }, {} as never, { systemPrompt: "" } as never);
  function done(callId: string, content: Record<string, unknown>, isError = false) {
    return facts.decide({ type: "tool.done", result: { callId, content, isError } } as ReactorInboundEvent, {} as ReactorState, caps);
  }
  const mail = { kind: "pr", repo: REPO, items: numbers.map((n) => ({ prNumber: n, headSha: `sha${n}` })), policy: { enabled: true }, checkPack: emptyPack(REPO) };
  await facts.decide({ type: "message.received", message: { content: JSON.stringify(mail) } } as ReactorInboundEvent, {} as ReactorState, caps);
  await done("github_list_open_prs", { prs: numbers.map((n) => ({ number: n, title: `PR ${n}` })) });
  for (const n of numbers) {
    if (failGetPr.has(n)) await done(`pr:${n}`, { error: "404" }, true);
    else await done(`pr:${n}`, { title: `PR ${n}`, author: "octocat", sha: `sha${n}`, state: "open", draft: false, mergeable: true, requestedReviewers: 0 });
    await done(`reviews:${n}`, { reviews: [] });
    await done(`commits:${n}`, { commits: [] });
    await done(`files:${n}`, { files: [] });
  }
  for (const n of numbers) if (!failGetPr.has(n)) await done(`checks:${n}`, { checks: [] });
  const render = triageDirectorFactory({ role: "render" }, {} as never, { systemPrompt: "" } as never);
  await render.decide({ type: "message.received", message: { content: replies[0]! } } as ReactorInboundEvent, {} as ReactorState, caps);
  return replies[1]!;
}

function events(numbers: number[], reply: string): WorkflowRunEvent[] {
  const payload = JSON.stringify({ kind: "pr", repo: REPO, items: numbers.map((n) => ({ prNumber: n, headSha: `sha${n}` })) });
  return [
    { seq: 0, type: "RunStarted", body: { type: "RunStarted", seq: 0, at: "2026-10-07T01:00:00.000Z", trigger: { type: "mail", payload } } },
    { seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "render", output: { ref: `inline:${JSON.stringify({ reply })}` } } },
    { seq: 2, type: "RunCompleted", body: { type: "RunCompleted", seq: 2 } },
  ];
}

async function observe(numbers: number[], reply: string) {
  const log = events(numbers, reply);
  const reader = {
    async listRunIds() { return ["run_batch"]; },
    async readRunEvents() { return log; },
    async readLatestRunEvents(_repo: unknown, _ref: string, include: (id: string) => boolean) {
      return { tip: "t", events: new Map(include("run_batch") ? [["run_batch", log.at(-1)!]] : []) };
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
