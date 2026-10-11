import { describe, expect, test } from "bun:test";
import { createSizeCapTransform } from "@intx/inference";
import { runLocal, type ActionHandler, type OnTriggerPrimitive, type StepInvoker, type WorkflowAuthorizeFn } from "@intx/workflow";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState, ToolCall, ToolResult } from "@intx/types/runtime";
import { REPO_DOCS_MAX_BYTES, type GithubFetch } from "@corbits/github-tool/github";
import { emptyPack, recommendedPack, type Action, type CheckPack } from "@corbits/triage-contracts";
import * as actions from "./actions/index.js";
import { triageDirectorFactory } from "./directors.js";
import { MAX_SYSTEM_ONE_STATE_BYTES } from "./logic/quality.js";
import type { Verdict } from "./logic/render.js";
import { workflow } from "./pr-triage.js";
import { workflow as historical } from "./pr-triage-historical.js";

const REPO = "acme/widgets";
const HELLO: Action = { id: "hello", when: "every", checks: [], branches: { always: [{ kind: "comment", automatic: false, target: { body: "hi" } }] } };

type Recorded = { method: string; path: string };
type FileRow = { filename: string; status: string; additions: number; deletions: number; patch?: string; previous_filename?: string };

const FLAG: FileRow = { filename: "src/flag.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const flag = true;" };

const README = `Run \`bun run dev\` to start.\n${"Read the guide.\n".repeat(500)}`;
const GUIDE = "設定を確認してください。\n".repeat(600);
// Together over the docs cap and several tool results long, with a multibyte doc split across pages.
const DOCS = [["README.md", README], ["docs/guide.md", GUIDE], ["vendor/lib/README.md", "Vendored."]] as const;

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** GitHub serving open pull request 8 changing `files`, failing every read of it when `missing`, with `prior` as its Triage comment. */
function fakeGithub(missing: boolean, files: FileRow[], prior?: string) {
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
    if (path === `/repos/${REPO}`) return Response.json({ default_branch: "main" });
    if (path.startsWith(`/repos/${REPO}/git/trees/`)) return Response.json({ sha: "tree", tree: DOCS.map(([doc, text], index) => ({ path: doc, type: "blob", sha: `blob${index}`, size: bytes(text) })) });
    if (path.startsWith(`/repos/${REPO}/git/blobs/blob`)) return new Response(DOCS[Number(path.slice(path.lastIndexOf("blob") + 4))]![1]);
    if (path.startsWith(`/repos/${REPO}/pulls/8/files`)) {
      const page = Number(new URL(path, "https://api.github.invalid").searchParams.get("page"));
      return Response.json(files.slice((page - 1) * 100, page * 100));
    }
    if (prior !== undefined && path.startsWith(`/repos/${REPO}/issues/8/comments?`)) return Response.json([{ id: 5, user: { type: "Bot" }, body: prior }]);
    if (method === "GET") return Response.json([]);
    return Response.json({});
  }
  return { gh: gh satisfies GithubFetch, requests };
}

const allow: WorkflowAuthorizeFn = async () => ({ effect: "allow", matchingGrants: [], resolvedBy: null });

type SystemOne = { questions: Array<{ id: string }>; state: { repository: { docs: Record<string, string> } } };

/** Calls every focused candidate unrelated and answers every other question yes, so each asked file needs docs and tests. */
function judgeText({ questions }: SystemOne) {
  function answer({ id }: { id: string }) {
    if (!id.startsWith("focused-candidate-")) return { id, type: "noul", noul: 0.9 };
    return { id, type: "choice", choice: "unrelated", probabilities: { primary_or_supporting: 0.1, unrelated: 0.7, movement_or_superseded: 0.1, ambiguous: 0.1 }, confidence: 0.9 };
  }
  return questions.map((q) => JSON.stringify(answer(q))).join("");
}

/** Runs each agent step's real director against the fake GitHub and a canned decision model, failing when `judgeFails`, as the reactor would, under Interchange's tool-result cap. */
function stepInvoker(gh: GithubFetch, invoked: string[], judged: SystemOne[], judgeFails: boolean): StepInvoker {
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
        if (action.type === "infer") {
          judged.push(action.request!.providerOptions.systemOne);
          queue.push((judgeFails
            ? { type: "inference.error", error: { message: "upstream 503" } }
            : { type: "inference.done", turn: { content: [{ type: "text", text: judgeText(action.request!.providerOptions.systemOne) }] } }) as ReactorInboundEvent);
        }
      }
    }
    if (reply === undefined) throw new Error(`${agent.id} never replied`);
    return { output: { reply, turn: {} } };
  };
}

const RULES_PATH = { invoked: ["triage-facts", "triage-mirror"], mirrors: ["mirrorRules"] };
const JUDGE_PATH = { invoked: ["triage-facts", "triage-judge", "triage-mirror"], mirrors: ["mirror"] };

async function triage(checkPack: CheckPack, { missing = false, backlog = false, files = [FLAG], judgeFails = false, cleanupMode = "automated", prior = undefined as string | undefined } = {}) {
  const { gh, requests } = fakeGithub(missing, files, prior);
  const policy = { enabled: true, cleanupMode };
  const invoked: string[] = [];
  const judged: SystemOne[] = [];
  const body = ((backlog ? historical : workflow).steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("triage body is not inline");
  const { terminalStatus, outputs } = await runLocal(body.inline, {
    authorize: allow,
    hasUpstreamSignalResolver: true,
    invokeStep: stepInvoker(gh, invoked, judged, judgeFails),
    actionResolver: (ref) => (actions as Record<string, ActionHandler>)[ref]!,
    triggerPayload: backlog ? { kind: "backlog", repo: REPO, policy, checkPack } : { kind: "pr", repo: REPO, prNumber: 8, policy, checkPack },
  }).complete;
  expect(terminalStatus).toBe("completed");
  const mirrors = Object.keys(outputs).filter((id) => id.startsWith("mirror"));
  return { path: { invoked, mirrors }, requests, judged, verdict: outputs["evaluate"] ?? outputs["evaluateRules"] };
}

describe("pr-triage body", () => {
  test("without model checks the judge is skipped and the verdict carries the pack's actions", async () => {
    const { path, requests, verdict } = await triage({ ...emptyPack(REPO), actions: [HELLO] });
    expect(path).toEqual(RULES_PATH);
    expect(verdict).toMatchObject({ repo: REPO, number: 8, headSha: "abc", degraded: null, actions: [{ id: "hello", kind: "comment", target: { body: "hi" } }] });
    expect(requests).toContainEqual({ method: "POST", path: `/repos/${REPO}/issues/8/labels` });
  });

  test("model checks run the judge on the repository's own docs and the verdict records its answers", async () => {
    const { path, judged, verdict } = await triage(recommendedPack(REPO));
    expect(path).toEqual(JUDGE_PATH);
    expect(judged).toHaveLength(1);
    const { "README.md": readme, "docs/guide.md": guide, ...rest } = judged[0]!.state.repository.docs;
    expect(readme).toBe(README);
    expect(GUIDE.startsWith(guide!)).toBe(true);
    const read = bytes(readme!) + bytes(guide!);
    expect(read).toBeGreaterThan(REPO_DOCS_MAX_BYTES - 3);
    expect(read).toBeLessThanOrEqual(REPO_DOCS_MAX_BYTES);
    expect(rest).toEqual({});
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => [c.check, c.result])).toEqual([["focused", "fail"], ["docs", "fail"], ["tests", "fail"]]);
    expect((verdict as Verdict).checks.find((c) => c.check === "focused")?.evidence).toEqual(["flag — src/flag.ts"]);
    expect((verdict as Verdict).checks.find((c) => c.check === "tests")?.evidence).toEqual(["src/flag.ts"]);
  });

  test("a file list past the tool-result cap still shows the judge its docs and test changes", async () => {
    const sources = Array.from({ length: 150 }, (_, index) => ({ ...FLAG, filename: `src/modules/feature-${index}/index.ts` }));
    const files = [...sources, { ...FLAG, filename: "docs/flag.md" }, { ...FLAG, filename: "src/flag.test.ts" }];
    expect(JSON.stringify(files).length).toBeGreaterThan(10_000);
    const pack = emptyPack(REPO);
    const { judged, verdict } = await triage({ ...pack, checks: { docs: { enabled: true }, tests: { enabled: true } } }, { files });
    expect(judged.flatMap((call) => call.questions)).toEqual([]);
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => [c.check, c.result])).toEqual([["docs", "pass"], ["tests", "pass"]]);
  });

  test("a deleted test does not cover the change and a pure rename asks nothing", async () => {
    const removed = { filename: "src/old.test.ts", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-test();" };
    const renamed = { filename: "src/moved.ts", previous_filename: "src/kept.ts", status: "renamed", additions: 0, deletions: 0 };
    const { judged, verdict } = await triage({ ...emptyPack(REPO), checks: { tests: { enabled: true } } }, { files: [FLAG, removed, renamed] });
    expect(judged.flatMap((call) => call.questions.map((question) => question.id))).toEqual(["tests-file-001"]);
    expect((verdict as Verdict).checks.find((c) => c.check === "tests")).toMatchObject({ result: "fail", evidence: ["src/flag.ts"] });
  });

  test("a pull request past the decision model budget is judged in several calls on every model check", async () => {
    const sources = Array.from({ length: 45 }, (_, index) => ({
      ...FLAG,
      filename: `src/feature-${index}.ts`,
      patch: ["@@ -0,0 +1,41 @@", `+export const feature${index} = true;`, ...Array.from({ length: 40 }, (_, line) => `+// ${"evidence ".repeat(6)}${line}`)].join("\n"),
    }));
    expect(sources.reduce((total, file) => total + file.patch.length, 0)).toBeGreaterThan(MAX_SYSTEM_ONE_STATE_BYTES);
    const files = [...sources, { ...FLAG, filename: "docs/flag.md" }, { ...FLAG, filename: "src/flag.test.ts" }];
    const { path, verdict } = await triage(recommendedPack(REPO), { files });
    expect(path.invoked.filter((agent) => agent === "triage-judge").length).toBeGreaterThanOrEqual(2);
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => [c.check, c.result])).toEqual([["focused", "fail"], ["docs", "pass"], ["tests", "pass"]]);
    expect((verdict as Verdict).checks.find((c) => c.check === "focused")?.evidence).toHaveLength(files.length);
  });

  test("an automated repository whose judge fails still posts a comment; a human-approved one does not", async () => {
    const comment = { method: "POST", path: `/repos/${REPO}/issues/8/comments` };
    const automated = await triage(recommendedPack(REPO), { judgeFails: true });
    expect(automated.verdict).toMatchObject({ degraded: "inference-outage", mirror: true, merge: { verdict: "not-recommended" } });
    expect((automated.verdict as Verdict).request.comment).toContain("Triage will re-check this pull request.");
    expect(automated.requests).toContainEqual(comment);
    const approved = await triage(recommendedPack(REPO), { judgeFails: true, cleanupMode: "human-approved" });
    expect(approved.verdict).toMatchObject({ degraded: "inference-outage", mirror: true });
    expect(approved.requests).not.toContainEqual(comment);
  });

  test("a re-triage with nothing left to fix replaces the earlier needs list with the approval note", async () => {
    const { requests, verdict } = await triage(emptyPack(REPO), { prior: "<!-- corbits-triage -->\n@octocat, please address the following:\n- Link an issue" });
    expect((verdict as Verdict).request.comment).toBe("No changes needed from you. A maintainer will review this pull request.");
    expect(requests).toContainEqual({ method: "PATCH", path: `/repos/${REPO}/issues/comments/5` });
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
