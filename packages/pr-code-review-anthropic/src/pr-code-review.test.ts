import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceEvent } from "@intx/types/inference-events";
import type { ToolResult } from "@intx/types/runtime";
import { projectLiveToInert, type StepInvokeRequest, type WorkflowAuthorizeFn } from "@intx/workflow";
import { checkoutUnder } from "@corbits/pr-code-review/actions/checkout";
import { DIFF_INDEX } from "@corbits/pr-code-review/diff-parts";
import { codeReviewAgents, credentialBindingsFor } from "@corbits/pr-code-review/agents";
import { codeReviewDirectors } from "@corbits/pr-code-review/directors";
import { CHECK_UNFINISHED, UNCITED } from "@corbits/pr-code-review/reader-director";
import { codeReviewWorkflow } from "@corbits/pr-code-review/pr-code-review";
import { CODE_REVIEW_PROVIDERS, stockTriggerMail } from "@corbits/triage-contracts";
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
/** The one patch file the checkout holds the diff in. */
const PATCH = "/diff/0001.patch";
const FINDING = { path: "src/a.ts", start: 2, end: 2, priority: 1, confidence: 0.9, title: "add subtracts", why: "it uses -", trigger: "add(1, 1)", code: "  return a - b;" };
/** A candidate the check step answers not real. */
const PLANTED = { path: "src/a.ts", start: 1, end: 1, priority: 2, confidence: 0.6, title: "add is not exported", why: "callers cannot import it", trigger: "import { add }", code: "export function add(a: number, b: number) {" };
const DISPROOF = "src/a.ts:1 `export function add(a: number, b: number) {` exports add.";
/** A file outside the diff, and a finding in it only the repository finder reports, which only reading it confirms. */
const CALLER = "import { add } from \"./a\";\nexport const four = add(2, 2);\n";
const OUTSIDE = { path: "src/b.ts", start: 2, end: 2, priority: 1, title: "four is 0", why: "add subtracts, so four is 0", trigger: "read four", code: "export const four = add(2, 2);" };

let dir: string;
let tarball: Uint8Array;
let model: ReturnType<typeof Bun.serve>;
const fetched: string[] = [];
/** The model each check call asked for. */
const checkModels: string[] = [];
/** How many of the diff finder's next answers are prose with no findings list. */
let diffFinderProse = 0;
/** Whether the diff finder greps for every line instead of reading the patch files. */
let diffFinderGreps = false;
/** Whether the repository finder answers in prose once it has read. */
let repoFinderProse = false;
/** Whether every plan model call is refused, with an error the client does not retry itself. */
let planRefused = false;
/** How many of the write step's next answers are prose with no JSON. */
let writeProse = 0;
/** Whether both finders also report `PLANTED`. */
let planted = false;
/** How many of the check step's next answers name no verdict it knows. */
let checkInvalid = 0;
/** Whether the repository finder also reports `OUTSIDE`. */
let outside = false;
/** Whether the check of `OUTSIDE` keeps reading past its budget, then confirms it, or never answers. */
let checkKeepsReading: "confirms" | "silent" | undefined;
/** Whether the check of `OUTSIDE` cites no line it read. */
let checkUncited = false;

const allow: WorkflowAuthorizeFn = async function allow() {
  return { effect: "allow", matchingGrants: [], resolvedBy: null };
};

async function host(input: string | URL | Request): Promise<Response> {
  const { pathname } = new URL(input instanceof Request ? input.url : input);
  fetched.push(pathname);
  if (pathname === `/repos/${REPO}/tarball/${SHA}`) return new Response(tarball);
  if (pathname === `/repos/${REPO}/contents/src/a.ts`) return new Response(FILE);
  if (pathname === `/repos/${REPO}/contents/src/b.ts`) return new Response(CALLER);
  return new Response("not found", { status: 404 });
}

interface MessagesRequest {
  model: string;
  system: unknown;
  messages: unknown[];
}

/** The check reads the finding's file, then confirms it, or, for `OUTSIDE`, confirms it only once it has read the caller. */
function verdict(sent: string) {
  if (checkInvalid > 0) {
    checkInvalid--;
    return { verdict: "maybe", reason: "Line 2 subtracts." };
  }

  if (sent.includes(PLANTED.title)) return { verdict: "not_real", reason: DISPROOF };
  if (!sent.includes(OUTSIDE.title)) return { verdict: "real", reason: "src/a.ts:2 `return a - b;` subtracts." };
  if (checkUncited) return { verdict: "real", reason: "four is 0 at line 9 of b.ts." };
  if (sent.includes("const four = add(2, 2)")) return { verdict: "real", reason: "src/b.ts:2 `export const four = add(2, 2);` is 0." };
  return { verdict: "unsure", reason: "The caller was not read." };
}

/** Each step's answer by its prompt; the diff finder reads the diff, and the repository finder reads three times, then answers. */
function answer(body: MessagesRequest) {
  const system = JSON.stringify(body.system);
  const sent = JSON.stringify(body.messages);
  const repoFinder = system.includes("rest of the codebase");
  const diffFinder = sent.includes("Review the diff and report") && !repoFinder;
  if (sent.includes("Plan the review")) return [{ type: "text", text: JSON.stringify({ areas: [], outside_diff: [] }) }];
  if (sent.includes("Verify this finding.") && checkKeepsReading === "confirms" && sent.includes("Budget spent")) return [{ type: "text", text: JSON.stringify(verdict(sent)) }];
  if (sent.includes("Verify this finding.") && checkKeepsReading && sent.includes(OUTSIDE.title)) {
    return [{ type: "tool_use", id: `verify-${sent.split("tool_result").length}`, name: "read_file", input: { path: OUTSIDE.path } }];
  }
  if (sent.includes("Verify this finding.") && !sent.includes("tool_result")) {
    return [{ type: "tool_use", id: "verify", name: "read_file", input: { path: sent.includes(OUTSIDE.title) ? OUTSIDE.path : "src/a.ts" } }];
  }
  if (sent.includes("Verify this finding.")) return [{ type: "text", text: JSON.stringify(verdict(sent)) }];
  if (diffFinder && diffFinderGreps && !sent.includes("tool_result")) return [{ type: "tool_use", id: "grep-diff", name: "grep", input: { pattern: "." } }];
  if (diffFinder && !sent.includes("tool_result")) {
    return [
      { type: "tool_use", id: "index", name: "read_file", input: { path: DIFF_INDEX } },
      { type: "tool_use", id: "diff", name: "read_file", input: { path: PATCH } },
    ];
  }
  if (repoFinder && !sent.includes("tool_result")) {
    return [
      { type: "tool_use", id: "read", name: "read_file", input: { path: "src/a.ts" } },
      { type: "tool_use", id: "grep", name: "grep", input: { pattern: "function add" } },
      { type: "tool_use", id: "escape", name: "read_file", input: { path: join(dir, "head/src/a.ts") } },
    ];
  }
  if (diffFinder && diffFinderProse > 0) {
    diffFinderProse--;
    return [{ type: "text", text: "The loop at src/a.ts:2 subtracts { instead of adding." }];
  }
  if (sent.includes("Write the review.") && writeProse > 0) {
    writeProse--;
    return [{ type: "text", text: "One defect: add subtracts." }];
  }
  if (repoFinder && repoFinderProse) return [{ type: "text", text: "I read src/a.ts and ran out of budget before writing findings." }];
  const reported = [FINDING, ...(planted ? [PLANTED] : []), ...(outside && repoFinder ? [OUTSIDE] : [])];
  let text: unknown = { findings: reported };
  if (system.includes("<cited_code>")) text = { groups: [{ defect: "add subtracts", members: [0], representative: 0 }] };
  if (sent.includes("Write the review.")) text = { summary: "One defect.", comments: [{ finding: 0, title: "add subtracts", body: "Use +." }] };
  return [{ type: "text", text: JSON.stringify(text) }];
}

beforeAll(function serve() {
  dir = mkdtempSync(join(tmpdir(), "code-review-"));
  mkdirSync(join(dir, "head/src"), { recursive: true });
  writeFileSync(join(dir, "head/src/a.ts"), FILE);
  writeFileSync(join(dir, "head/src/b.ts"), CALLER);
  execFileSync("tar", ["-czf", join(dir, "head.tgz"), "-C", dir, "head"], { env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" } });
  tarball = readFileSync(join(dir, "head.tgz"));
  model = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as MessagesRequest;
      if (planRefused && JSON.stringify(body.messages).includes("Plan the review")) {
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Refused" } }, { status: 400 });
      }
      if (JSON.stringify(body.messages).includes("Verify this finding.")) checkModels.push(body.model);
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
async function review(checkoutDir: string, readerDir = checkoutDir, budgets?: { repoFinder?: number; check?: number }) {
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

test("the finders read the diff and the head the checkout action put on the sidecar, confined to it, and a second review of the head reuses it", async () => {
  const first = await review(join(dir, "data"));
  expect(first.run.terminalStatus).toBe("completed");
  expect(first.run.outputs["checkout"]).toEqual({ path: join(dir, "data/checkouts/github/acme/widgets", SHA) });
  expect(first.run.outputs["lint"]).toEqual({ status: "skipped", reason: "no lint config" });
  const results = Object.fromEntries(first.results.map((r) => [r.callId, r]));
  expect(results["index"]).toMatchObject({ content: { text: `1\t${JSON.stringify({ path: "src/a.ts", status: "modified", lines: 8, patches: [PATCH] })}\n2\t` } });
  expect(results["diff"]).toMatchObject({ content: { path: PATCH, text: expect.stringContaining("+  return a - b;") } });
  expect(results["read"]).toMatchObject({ content: { path: "src/a.ts", text: "1\texport function add(a: number, b: number) {\n2\t  return a - b;\n3\t}\n4\t" } });
  expect(results["grep"]).toMatchObject({ content: { matches: [{ path: "src/a.ts", line: 1 }] } });
  expect(results["escape"]).toMatchObject({ content: `${join(dir, "head/src/a.ts")} is outside the repository`, isError: true });
  expect(first.run.outputs["review"]).toMatchObject({ summary: "One defect.", complete: true, comments: [{ path: "src/a.ts", start: 2, title: "add subtracts", agreement: { finders: 2 } }] });
  expect(new Set(checkModels)).toEqual(new Set([CODE_REVIEW_PROVIDERS.anthropic.models.fast]));

  const second = await review(join(dir, "data"));
  expect(second.run.terminalStatus).toBe("completed");
  expect(fetched.filter((path) => path.includes("/tarball/"))).toHaveLength(1);
});

test("a review whose finders grepped rather than reading the patch files is not complete, and grep never shows them", async () => {
  diffFinderGreps = true;
  try {
    const { run, results } = await review(join(dir, "data"));
    expect(run.terminalStatus).toBe("completed");
    const grepped = results.find((r) => r.callId === "grep-diff")!.content as { matches: { path: string }[] };
    expect(new Set(grepped.matches.map((match) => match.path))).toEqual(new Set(["src/a.ts", "src/b.ts"]));
    expect(run.outputs["review"]).toMatchObject({ complete: false, comments: [{ path: "src/a.ts", start: 2 }] });
  } finally {
    diffFinderGreps = false;
  }
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

test("a review whose checkout is not on this sidecar fails at its first step that reads it", async () => {
  const { run } = await review(join(dir, "here"), join(dir, "elsewhere"));
  expect(run.terminalStatus).not.toBe("completed");
  expect(run.outputs["plan"]).toBeUndefined();
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

test("a candidate the check answers not real is left out of the review and kept with the line that disproves it", async () => {
  planted = true;
  try {
    const { run, attempts } = await review(join(dir, "data"));
    expect(run.terminalStatus).toBe("completed");
    expect(attempts["code-review-check"]).toBe(2);
    expect(run.outputs["review"]).toMatchObject({
      comments: [{ path: "src/a.ts", start: 2, title: "add subtracts" }],
      dropped: [{ path: "src/a.ts", start: 1, title: "add is not exported", verdict: "not_real", reason: DISPROOF }],
    });
  } finally {
    planted = false;
  }
});

test("a check answer that is not a verdict and reason fails its step, which asks again", async () => {
  checkInvalid = 1;
  const { run, attempts } = await review(join(dir, "data"));
  expect(checkInvalid).toBe(0);
  expect(attempts["code-review-check"]).toBe(2);
  expect(run.terminalStatus).toBe("completed");
  expect(run.outputs["review"]).toMatchObject({ comments: [{ path: "src/a.ts", start: 2 }], dropped: [] });
});

test("a finding one finder reports outside the diff is posted once the check reads the file that proves it", async () => {
  outside = true;
  try {
    const { run, results } = await review(join(dir, "data"), join(dir, "data"), { check: 30 });
    expect(run.terminalStatus).toBe("completed");
    expect(results.find((r) => r.callId === "verify" && JSON.stringify(r.content).includes("add(2, 2)"))).toMatchObject({ content: { path: "src/b.ts" } });
    expect(run.outputs["review"]).toMatchObject({ comments: [{ path: "src/a.ts", start: 2 }, { path: "src/b.ts", start: 2, title: "four is 0", agreement: { finders: 1 } }], dropped: [] });
  } finally {
    outside = false;
  }
});

test("a check whose reason cites no line it read is unsure, so a finding one finder reported is left out", async () => {
  outside = true;
  checkUncited = true;
  try {
    const { run, attempts } = await review(join(dir, "data"));
    expect(run.terminalStatus).toBe("completed");
    expect(attempts["code-review-check"]).toBe(2);
    expect(run.outputs["review"]).toMatchObject({
      comments: [{ path: "src/a.ts", start: 2 }],
      dropped: [{ path: "src/b.ts", start: 2, verdict: "unsure", reason: `${UNCITED}: four is 0 at line 9 of b.ts.` }],
    });
  } finally {
    outside = false;
    checkUncited = false;
  }
});

for (const [mode, reason] of [["confirms", "src/b.ts:2 `export const four = add(2, 2);` is 0."], ["silent", CHECK_UNFINISHED]] as const) {
  test(`a check refused a read for its budget that then ${mode === "confirms" ? "confirms with a cited line" : "never answers"} is unsure, so a finding one finder reported is left out`, async () => {
    outside = true;
    checkKeepsReading = mode;
    try {
      const { run, attempts } = await review(join(dir, "data"), join(dir, "data"), { check: 30 });
      expect(run.terminalStatus).toBe("completed");
      expect(attempts["code-review-check"]).toBe(2);
      expect(run.outputs["review"]).toMatchObject({
        comments: [{ path: "src/a.ts", start: 2 }],
        dropped: [{ path: "src/b.ts", start: 2, verdict: "unsure", reason }],
      });
    } finally {
      outside = false;
      checkKeepsReading = undefined;
    }
  });
}
