import { describe, expect, test } from "bun:test";
import { runLocal, type ActionHandler, type OnTriggerPrimitive, type StepInvoker, type WorkflowAuthorizeFn } from "@intx/workflow";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState, ToolCall, ToolResult } from "@intx/types/runtime";
import type { GithubFetch } from "@corbits/github-tool/github";
import { emptyPack, recommendedPack, type Action, type CheckPack } from "@corbits/triage-contracts";
import * as actions from "./actions/index.js";
import { triageDirectorFactory } from "./directors.js";
import type { Verdict } from "./logic/render.js";
import { workflow } from "./pr-triage.js";
import { workflow as historical } from "./pr-triage-historical.js";

const REPO = "acme/widgets";
const HELLO: Action = { id: "hello", when: "every", checks: [], branches: { always: [{ kind: "comment", automatic: false, target: { body: "hi" } }] } };

type Recorded = { method: string; path: string };

/** GitHub serving open pull request 8, failing every read of it when `missing`. */
function fakeGithub(missing: boolean) {
  const requests: Recorded[] = [];
  async function gh(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    requests.push({ method, path });
    if (missing && path.includes("/pulls/8")) return Response.json({ message: "Not Found" }, { status: 404 });
    if (path.startsWith(`/repos/${REPO}/pulls?`)) return Response.json([{ number: 8, title: "Fix #3", user: { login: "octocat" }, draft: false, head: { sha: "abc" } }]);
    if (path === `/repos/${REPO}/pulls/8`) {
      return Response.json({ number: 8, title: "Fix #3", state: "open", draft: false, user: { login: "octocat" }, head: { sha: "abc", ref: "fix" }, base: { ref: "main" }, mergeable: true, labels: [], requested_reviewers: [{ login: "rev" }] });
    }
    if (path.includes("/check-runs")) return Response.json({ check_runs: [] });
    if (method === "GET") return Response.json([]);
    return Response.json({});
  }
  return { gh: gh satisfies GithubFetch, requests };
}

const allow: WorkflowAuthorizeFn = async () => ({ effect: "allow", matchingGrants: [], resolvedBy: null });

function judgeText(questions: Array<{ id: string }>) {
  return questions.map((q) => JSON.stringify({ id: q.id, type: "noul", noul: q.id === "focused" ? 0.1 : 0.9 })).join("");
}

/** Runs each agent step's real director against the fake GitHub and a canned decision model, as the reactor would. */
function stepInvoker(gh: GithubFetch, invoked: string[]): StepInvoker {
  const env = { capabilities: { resolve: () => ({ resolve: async () => ({ kind: "http", fetch: gh }) }) } };
  return async function invokeStep({ agent, input }) {
    invoked.push(agent.id);
    const tools = agent.toolFactories.map((factory) => factory(env as never) as unknown as { run(call: ToolCall): Promise<ToolResult> });
    let reply: string | undefined;
    const caps = {
      executeTools(calls: ToolCall[]) { return { type: "execute_tools", calls }; },
      infer(request: { providerOptions: { systemOne: { questions: Array<{ id: string }> } } }) { return { type: "infer", request }; },
      reply(content: string) { reply = content; return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory(agent.director!.config as never, {} as never, agent as never);
    const queue: ReactorInboundEvent[] = [{ type: "message.received", message: { content: JSON.stringify(input) } } as ReactorInboundEvent];
    for (let event = queue.shift(); event !== undefined && reply === undefined; event = queue.shift()) {
      const taken = [await director.decide(event, {} as ReactorState, caps)].flat() as unknown as Array<{ type: string; calls?: ToolCall[]; request?: { providerOptions: { systemOne: { questions: Array<{ id: string }> } } } }>;
      for (const action of taken) {
        if (action.type === "execute_tools") for (const call of action.calls!) queue.push({ type: "tool.done", result: await tools[0]!.run(call) } as ReactorInboundEvent);
        if (action.type === "infer") queue.push({ type: "inference.done", turn: { content: [{ type: "text", text: judgeText(action.request!.providerOptions.systemOne.questions) }] } } as ReactorInboundEvent);
      }
    }
    if (reply === undefined) throw new Error(`${agent.id} never replied`);
    return { output: { reply, turn: {} } };
  };
}

const POLICY = { enabled: true, cleanupMode: "automated" };
const RULES_PATH = { invoked: ["triage-facts", "triage-mirror"], mirrors: ["mirrorRules"] };
const JUDGE_PATH = { invoked: ["triage-facts", "triage-judge", "triage-mirror"], mirrors: ["mirror"] };

async function triage(checkPack: CheckPack, { missing = false, backlog = false } = {}) {
  const { gh, requests } = fakeGithub(missing);
  const invoked: string[] = [];
  const body = ((backlog ? historical : workflow).steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("triage body is not inline");
  const { terminalStatus, outputs } = await runLocal(body.inline, {
    authorize: allow,
    hasUpstreamSignalResolver: true,
    invokeStep: stepInvoker(gh, invoked),
    actionResolver: (ref) => (actions as Record<string, ActionHandler>)[ref]!,
    triggerPayload: backlog ? { kind: "backlog", repo: REPO, policy: POLICY, checkPack } : { kind: "pr", repo: REPO, prNumber: 8, policy: POLICY, checkPack },
  }).complete;
  expect(terminalStatus).toBe("completed");
  const mirrors = Object.keys(outputs).filter((id) => id.startsWith("mirror"));
  return { path: { invoked, mirrors }, requests, verdict: outputs["evaluate"] ?? outputs["evaluateRules"] };
}

describe("pr-triage body", () => {
  test("without model checks the judge is skipped and the verdict carries the pack's actions", async () => {
    const { path, requests, verdict } = await triage({ ...emptyPack(REPO), actions: [HELLO] });
    expect(path).toEqual(RULES_PATH);
    expect(verdict).toMatchObject({ repo: REPO, number: 8, headSha: "abc", degraded: null, actions: [{ id: "hello", kind: "comment", target: { body: "hi" } }] });
    expect(requests).toContainEqual({ method: "POST", path: `/repos/${REPO}/issues/8/labels` });
  });

  test("model checks run the judge and the verdict records its answers", async () => {
    const { path, verdict } = await triage(recommendedPack(REPO));
    expect(path).toEqual(JUDGE_PATH);
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => [c.check, c.result])).toEqual([["focused", "fail"], ["docs", "pass"], ["tests", "pass"]]);
  });

  test("facts that fail degrade the verdict and suggest no actions", async () => {
    const { path, verdict } = await triage({ ...recommendedPack(REPO), actions: [HELLO] }, { missing: true });
    expect(path).toEqual(RULES_PATH);
    expect(verdict).toMatchObject({ degraded: "error", reason: "github_get_pr failed for #8", actions: [] });
  });

  test("a backlog judges the listed pull requests and evaluates them as one batch", async () => {
    const { path, verdict } = await triage(recommendedPack(REPO), { backlog: true });
    expect(path).toEqual(JUDGE_PATH);
    expect(verdict).toMatchObject({ items: [{ number: 8, degraded: null }], summary: { total: 1 } });
  });
});
