import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceEvent } from "@intx/types/inference-events";
import type { ToolResult } from "@intx/types/runtime";
import { projectLiveToInert, type StepInvokeRequest, type WorkflowAuthorizeFn } from "@intx/workflow";
import { checkoutUnder } from "@corbits/pr-code-review/actions/checkout";
import { codeReviewAgents, credentialBindingsFor } from "@corbits/pr-code-review/agents";
import { codeReviewDirectors } from "@corbits/pr-code-review/directors";
import { codeReviewWorkflow } from "@corbits/pr-code-review/pr-code-review";
import { stockTriggerMail } from "@corbits/triage-contracts";
import { runLocalWorkflow } from "../../triage-workflows/src/run-local.js";
import * as actions from "./actions/index.js";
import { workflow as reviewerBitbucket } from "./pr-code-review-reviewer-bitbucket-datacenter.js";
import { workflow as reviewerGithub } from "./pr-code-review-reviewer-github.js";
import { ANTHROPIC } from "./profile.js";

test("a manager's code review may only report its result and stop its own run", () => {
  for (const reviewer of [reviewerGithub, reviewerBitbucket]) {
    expect(reviewer.grantRequirements).toEqual([
      { resource: "triage-manager:result", action: "create", source: "creator" },
      { resource: "workflow-run:self", action: "manage", source: "creator" },
    ]);
  }
});

test("every deployed code review requires a sidecar of its own", () => {
  for (const definition of [reviewerGithub, reviewerBitbucket]) {
    expect(projectLiveToInert(definition).sidecarPlacement).toEqual({ capabilities: [{ capability: "isolation:workload", effect: "require" }] });
  }
});

const REPO = "acme/widgets";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const FILE = "export function add(a: number, b: number) {\n  return a - b;\n}\n";
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number) {\n-  return a + b;\n+  return a - b;\n }\n";
const FINDING = { path: "src/a.ts", start: 2, end: 2, priority: 1, confidence: 0.9, title: "add subtracts", why: "it uses -", trigger: "add(1, 1)", code: "  return a - b;" };

let dir: string;
let tarball: Uint8Array;
let model: ReturnType<typeof Bun.serve>;
const fetched: string[] = [];
/** How many of the diff finder's next answers are prose with no findings list. */
let diffFinderProse = 0;
/** Whether the repository finder answers in prose once it has read. */
let repoFinderProse = false;
/** Whether every plan model call is refused, with an error the client does not retry itself. */
let planRefused = false;
/** How many of the write step's next answers are prose with no JSON. */
let writeProse = 0;

const allow: WorkflowAuthorizeFn = async function allow() {
  return { effect: "allow", matchingGrants: [], resolvedBy: null };
};

async function host(input: string | URL | Request): Promise<Response> {
  const { pathname } = new URL(input instanceof Request ? input.url : input);
  fetched.push(pathname);
  if (pathname === `/repos/${REPO}/tarball/${SHA}`) return new Response(tarball);
  if (pathname === `/repos/${REPO}/contents/src/a.ts`) return new Response(FILE);
  return new Response("not found", { status: 404 });
}

interface MessagesRequest {
  model: string;
  system: unknown;
  messages: unknown[];
}

/** Each step's answer by its prompt; the repository finder reads three times, then answers. */
function answer(body: MessagesRequest) {
  const system = JSON.stringify(body.system);
  const sent = JSON.stringify(body.messages);
  if (system.includes("<tools>") && !sent.includes("tool_result")) {
    return [
      { type: "tool_use", id: "read", name: "read_file", input: { path: "src/a.ts" } },
      { type: "tool_use", id: "grep", name: "grep", input: { pattern: "add" } },
      { type: "tool_use", id: "escape", name: "read_file", input: { path: join(dir, "head/src/a.ts") } },
    ];
  }
  if (sent.includes("Review the diff above") && !system.includes("<tools>") && diffFinderProse > 0) {
    diffFinderProse--;
    return [{ type: "text", text: "The loop at src/a.ts:2 subtracts { instead of adding." }];
  }
  if (sent.includes("Write the review.") && writeProse > 0) {
    writeProse--;
    return [{ type: "text", text: "One defect: add subtracts." }];
  }
  if (system.includes("<tools>") && repoFinderProse) return [{ type: "text", text: "I read src/a.ts and ran out of budget before writing findings." }];
  let text: unknown = { findings: [FINDING] };
  if (system.includes("<cited_code>")) text = { groups: [{ defect: "add subtracts", members: [0], representative: 0 }] };
  if (sent.includes("Plan the review")) text = { areas: [], outside_diff: [] };
  if (sent.includes("Write the review.")) text = { summary: "One defect.", comments: [{ finding: 0, title: "add subtracts", body: "Use +." }] };
  return [{ type: "text", text: JSON.stringify(text) }];
}

beforeAll(function serve() {
  dir = mkdtempSync(join(tmpdir(), "code-review-"));
  mkdirSync(join(dir, "head/src"), { recursive: true });
  writeFileSync(join(dir, "head/src/a.ts"), FILE);
  execFileSync("tar", ["-czf", join(dir, "head.tgz"), "-C", dir, "head"], { env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" } });
  tarball = readFileSync(join(dir, "head.tgz"));
  model = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as MessagesRequest;
      if (planRefused && JSON.stringify(body.messages).includes("Plan the review")) {
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Refused" } }, { status: 400 });
      }
      const content = answer(body);
      const stop = content[0]!.type === "tool_use" ? "tool_use" : "end_turn";
      const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      return Response.json({ id: "msg", type: "message", role: "assistant", model: body.model, content, stop_reason: stop, stop_sequence: null, usage });
    },
  });
});

afterAll(function stop() {
  model.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

/** A clock a minute further on at every reading, so each retry's backoff has passed by the time it is timed. */
function hurried() {
  let readings = 0;
  return function clock() {
    return new Date(Date.now() + ++readings * 60_000);
  };
}

/** A review whose checkout action writes under `checkoutDir` and whose repository finder reads under `readerDir`. */
async function review(checkoutDir: string, readerDir = checkoutDir, budgets?: { repoFinder: number }) {
  const origin = `http://localhost:${model.port}`;
  const results: ToolResult[] = [];
  const attempts: Record<string, number> = {};
  function readerDataDir() {
    return readerDir;
  }
  const directors = codeReviewDirectors(ANTHROPIC, readerDataDir);
  function sourceFor(req: StepInvokeRequest) {
    return { id: req.agent.id, provider: "anthropic", baseURL: origin, credentialId: "inference", model: req.agent.inference.sources[0]!.model };
  }
  function onEvent(event: InferenceEvent) {
    if (event.type === "tool.done") results.push(event.data.result);
  }
  function onStepDone(agentId: string) {
    attempts[agentId] = (attempts[agentId] ?? 0) + 1;
  }
  const request = { kind: "code-review", title: "Add", description: "", diff: DIFF, checkout: { source: "github", repo: REPO, sha: SHA }, ...(budgets && { budgets }) };
  const run = await runLocalWorkflow({
    workflow: codeReviewWorkflow(codeReviewAgents(ANTHROPIC, directors, readerDataDir))({ sources: ["github"] }),
    directors: Object.values(directors).map((d) => d.factory),
    actions: { ...actions, checkout: checkoutUnder(() => checkoutDir) },
    credentialBindings: credentialBindingsFor(["github"]),
    authorize: allow,
    github: host,
    inference: { credentialId: "inference", origin, apiKey: "local" },
    sourceFor,
    triggerPayload: stockTriggerMail(request),
    onEvent,
    onStepDone,
    clock: hurried(),
  });
  return { run, results, attempts };
}

test("the repository finder reads the head the checkout action put on the sidecar, confined to it, and a second review of the head reuses it", async () => {
  const first = await review(join(dir, "data"));
  expect(first.run.terminalStatus).toBe("completed");
  expect(first.run.outputs["checkout"]).toEqual({ path: join(dir, "data/checkouts/github/acme/widgets", SHA) });
  expect(first.run.outputs["lint"]).toEqual({ status: "skipped", reason: "no lint config" });
  const results = Object.fromEntries(first.results.map((r) => [r.callId, r]));
  expect(results["read"]).toMatchObject({ content: { path: "src/a.ts", text: "1\texport function add(a: number, b: number) {\n2\t  return a - b;\n3\t}\n4\t" } });
  expect(results["grep"]).toMatchObject({ content: { matches: [{ path: "src/a.ts", line: 1 }] } });
  expect(results["escape"]).toMatchObject({ content: `${join(dir, "head/src/a.ts")} is outside the repository`, isError: true });
  expect(first.run.outputs["review"]).toMatchObject({ summary: "One defect.", comments: [{ path: "src/a.ts", start: 2, title: "add subtracts", agreement: { finders: 2 } }] });

  const second = await review(join(dir, "data"));
  expect(second.run.terminalStatus).toBe("completed");
  expect(fetched.filter((path) => path.includes("/tarball/"))).toHaveLength(1);
});

test("a finder answer with no findings list fails its step, which asks again rather than reading as a clean review", async () => {
  diffFinderProse = 1;
  const { run } = await review(join(dir, "data"));
  expect(diffFinderProse).toBe(0);
  expect(run.terminalStatus).toBe("completed");
  expect(run.outputs["review"]).toMatchObject({ comments: [{ path: "src/a.ts", start: 2, agreement: { finders: 2 } }] });
});

test("a repository finder that spends its budget and then answers in prose stopped early with nothing found", async () => {
  repoFinderProse = true;
  try {
    const { run } = await review(join(dir, "data"), join(dir, "data"), { repoFinder: 30 });
    expect(run.terminalStatus).toBe("completed");
    expect(run.outputs["review"]).toMatchObject({ budgetExhausted: true, comments: [{ path: "src/a.ts", start: 2, agreement: { finders: 1 } }] });
  } finally {
    repoFinderProse = false;
  }
});

test("a review whose checkout is not on this sidecar fails at the repository finder", async () => {
  const { run } = await review(join(dir, "here"), join(dir, "elsewhere"));
  expect(run.terminalStatus).not.toBe("completed");
  expect(run.outputs["findRepo"]).toBeUndefined();
});

test("a plan step whose model call keeps failing fails the review after its tries rather than handing the finders its error", async () => {
  planRefused = true;
  try {
    const { run, attempts } = await review(join(dir, "data"));
    expect(run.terminalStatus).not.toBe("completed");
    expect(attempts["code-review-plan"]).toBe(3);
    expect(run.outputs["findersInput"]).toBeUndefined();
  } finally {
    planRefused = false;
  }
});

test("a write answer that isn't JSON fails its step, which asks again", async () => {
  writeProse = 1;
  const { run, attempts } = await review(join(dir, "data"));
  expect(writeProse).toBe(0);
  expect(attempts["code-review-write"]).toBe(2);
  expect(run.terminalStatus).toBe("completed");
  expect(run.outputs["review"]).toMatchObject({ summary: "One defect." });
});
