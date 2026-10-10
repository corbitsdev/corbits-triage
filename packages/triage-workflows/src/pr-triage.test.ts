import { describe, expect, test } from "bun:test";
import { createSizeCapTransform } from "@intx/inference";
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
type FileRow = { filename: string; status: string; additions: number; deletions: number; patch: string };

const FLAG: FileRow = { filename: "src/flag.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const flag = true;" };

/** GitHub serving open pull request 8 changing `files`, failing every read of it when `missing`. */
function fakeGithub(missing: boolean, files: FileRow[]) {
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
    if (path.startsWith(`/repos/${REPO}/pulls/8/files`)) {
      const page = Number(new URL(path, "https://api.github.invalid").searchParams.get("page"));
      return Response.json(files.slice((page - 1) * 100, page * 100));
    }
    if (method === "GET") return Response.json([]);
    return Response.json({});
  }
  return { gh: gh satisfies GithubFetch, requests };
}

const allow: WorkflowAuthorizeFn = async () => ({ effect: "allow", matchingGrants: [], resolvedBy: null });

type SystemOne = { questions: Array<{ id: string }>; state: { paths: string[] } };

/** Calls every focused candidate unrelated, passes docs and tests only when a changed path is one, and passes every other question. */
function judgeText({ questions, state }: SystemOne) {
  function answer({ id }: { id: string }) {
    if (id === "docs") return { id, type: "noul", noul: state.paths.some((path) => path.startsWith("docs/")) ? 0.9 : 0.1 };
    if (id === "tests") return { id, type: "noul", noul: state.paths.some((path) => path.includes(".test.")) ? 0.9 : 0.1 };
    if (!id.startsWith("focused-candidate-")) return { id, type: "noul", noul: 0.9 };
    return { id, type: "choice", choice: "unrelated", probabilities: { primary_or_supporting: 0.1, unrelated: 0.7, movement_or_superseded: 0.1, ambiguous: 0.1 }, confidence: 0.9 };
  }
  return questions.map((q) => JSON.stringify(answer(q))).join("");
}

/** Runs each agent step's real director against the fake GitHub and a canned decision model, as the reactor would, under Interchange's tool-result cap. */
function stepInvoker(gh: GithubFetch, invoked: string[]): StepInvoker {
  const env = { capabilities: { resolve: () => ({ resolve: async () => ({ kind: "http", fetch: gh }) }) } };
  const sizeCap = createSizeCapTransform({ maxChars: 10_000, contextStore: { writeBlob: async () => {} } });
  return async function invokeStep({ agent, input }) {
    invoked.push(agent.id);
    const tools = agent.toolFactories.map((factory) => factory(env as never) as unknown as { run(call: ToolCall): Promise<ToolResult> });
    let reply: string | undefined;
    const caps = {
      executeTools(calls: ToolCall[]) { return { type: "execute_tools", calls }; },
      infer(request: { providerOptions: { systemOne: SystemOne } }) { return { type: "infer", request }; },
      reply(content: string) { reply = content; return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory(agent.director!.config as never, {} as never, agent as never);
    const queue: ReactorInboundEvent[] = [{ type: "message.received", message: { content: JSON.stringify(input) } } as ReactorInboundEvent];
    for (let event = queue.shift(); event !== undefined && reply === undefined; event = queue.shift()) {
      const taken = [await director.decide(event, {} as ReactorState, caps)].flat() as unknown as Array<{ type: string; calls?: ToolCall[]; request?: { providerOptions: { systemOne: SystemOne } } }>;
      for (const action of taken) {
        if (action.type === "execute_tools") {
          for (const call of action.calls!) {
            const { output } = await sizeCap.apply({ call, result: await tools[0]!.run(call) }, {} as never);
            queue.push({ type: "tool.done", result: output } as ReactorInboundEvent);
          }
        }
        if (action.type === "infer") queue.push({ type: "inference.done", turn: { content: [{ type: "text", text: judgeText(action.request!.providerOptions.systemOne) }] } } as ReactorInboundEvent);
      }
    }
    if (reply === undefined) throw new Error(`${agent.id} never replied`);
    return { output: { reply, turn: {} } };
  };
}

const POLICY = { enabled: true, cleanupMode: "automated" };
const RULES_PATH = { invoked: ["triage-facts", "triage-mirror"], mirrors: ["mirrorRules"] };
const JUDGE_PATH = { invoked: ["triage-facts", "triage-judge", "triage-mirror"], mirrors: ["mirror"] };

async function triage(checkPack: CheckPack, { missing = false, backlog = false, files = [FLAG] } = {}) {
  const { gh, requests } = fakeGithub(missing, files);
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
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => [c.check, c.result])).toEqual([["focused", "fail"], ["docs", "fail"], ["tests", "fail"]]);
    expect((verdict as Verdict).checks.find((c) => c.check === "focused")?.evidence).toEqual(["flag — src/flag.ts"]);
  });

  test("a file list past the tool-result cap still shows the judge its docs and test changes", async () => {
    const sources = Array.from({ length: 150 }, (_, index) => ({ ...FLAG, filename: `src/modules/feature-${index}/index.ts` }));
    const files = [...sources, { ...FLAG, filename: "docs/flag.md" }, { ...FLAG, filename: "src/flag.test.ts" }];
    expect(JSON.stringify(files).length).toBeGreaterThan(10_000);
    const pack = emptyPack(REPO);
    const { verdict } = await triage({ ...pack, checks: { docs: { enabled: true }, tests: { enabled: true } } }, { files });
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => [c.check, c.result])).toEqual([["docs", "pass"], ["tests", "pass"]]);
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
