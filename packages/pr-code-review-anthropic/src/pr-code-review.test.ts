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
import { CHECK_UNFINISHED, UNCITED } from "@corbits/pr-code-review/reader-director";
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
let finderBudgetSpent = false;
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
/** How many of the diff finder's next answers are prose with no findings list. */
let diffFinderProse = 0;
/** Whether every finder call is refused with a non-retryable provider error. */
let finderRefused = false;
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

/** The finder answers directly from its input; the check may read supporting repository code. */
function answer(body: MessagesRequest) {
  const sent = JSON.stringify(body.messages);
  if (sent.includes("Verify this finding.") && checkKeepsReading === "confirms" && sent.includes("Budget spent")) return [{ type: "text", text: JSON.stringify(verdict(sent)) }];
  if (sent.includes("Verify this finding.") && checkKeepsReading && sent.includes(OUTSIDE.title)) {
    return [{ type: "tool_use", id: `verify-${sent.split("tool_result").length}`, name: "read_file", input: { path: OUTSIDE.path } }];
  }
  if (sent.includes("Verify this finding.") && !sent.includes("tool_result")) {
    return [{ type: "tool_use", id: "verify", name: "read_file", input: { path: sent.includes(OUTSIDE.title) ? OUTSIDE.path : "src/a.ts" } }];
  }
  if (sent.includes("Verify this finding.")) return [{ type: "text", text: JSON.stringify(verdict(sent)) }];
  expect(sent).toContain("Review the diff and report");
  expect(sent).toContain("+  return a - b;");
  expect(sent).not.toContain("<diff index=");
  expect(JSON.stringify(body.system)).not.toContain("Read the index");
  if (finderBudgetSpent) return [{ type: "text", text: "Budget exhausted before JSON." }];
  if (diffFinderProse > 0) {
    diffFinderProse--;
    return [{ type: "text", text: "The loop at src/a.ts:2 subtracts { instead of adding." }];
  }
  return [{ type: "text", text: JSON.stringify({ findings: [FINDING, ...(planted ? [PLANTED] : []), ...(outside ? [OUTSIDE] : [])] }) }];
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
      if (finderRefused && JSON.stringify(body.messages).includes("Review the diff and report")) {
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Refused" } }, { status: 400 });
      }
      const content = answer(body);
      const stop = content[0]!.type === "tool_use" ? "tool_use" : "end_turn";
      const usage = { input_tokens: finderBudgetSpent ? 400_000 : 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
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
async function review(checkoutDir: string, readerDir = checkoutDir, budgets?: { check?: number }, diff = DIFF) {
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
  const request = { kind: "code-review", title: "Add", description: "", diff, checkout: { source: "github", repo: REPO, sha: SHA }, ...(budgets && { budgets }) };
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

test("the finder receives the actual patch, answers without paging, and preserves its words and anchors", async () => {
  const first = await review(join(dir, "data"));
  expect(first.run.terminalStatus).toBe("completed");
  expect(first.run.outputs["checkout"]).toEqual({ path: join(dir, "data/checkouts/github/acme/widgets", SHA) });
  expect(first.run.outputs["lint"]).toEqual({ status: "skipped", reason: "no lint config" });
  expect(first.run.outputs["review"]).toMatchObject({ summary: "", complete: true, comments: [{ path: FINDING.path, start: FINDING.start, end: FINDING.end, title: FINDING.title, body: `${FINDING.why}\n\n${FINDING.trigger}`, agreement: { finders: 1 } }] });
  expect(first.results.some((r) => r.callId === "index" || r.callId === "diff")).toBe(false);
  const second = await review(join(dir, "data"));
  expect(second.run.terminalStatus).toBe("completed");
  expect(fetched.filter((path) => path.includes("/tarball/"))).toHaveLength(1);
});

test("empty assignment completes without inference", async () => {
  const { run, attempts } = await review(join(dir, "data"), join(dir, "data"), undefined, "");
  expect(run.terminalStatus).toBe("completed");
  expect(attempts).toEqual({});
  expect(run.outputs["review"]).toMatchObject({ summary: "No defects reported.", comments: [], complete: true, budgetExhausted: false });
});

test("an exhausted finder reply is complete but exhausted, not a partial-read result", async () => {
  finderBudgetSpent = true;
  try {
    const { run } = await review(join(dir, "data"));
    expect(run.terminalStatus).toBe("completed");
    expect(run.outputs["review"]).toMatchObject({ summary: "No defects reported.", comments: [], complete: true, budgetExhausted: true, unread: [], unreadFiles: 0 });
  } finally {
    finderBudgetSpent = false;
  }
});

test("both hosts retain only checkout credentials and the same narrow stages", () => {
  for (const source of ["github", "bitbucket-datacenter"] as const) {
    expect(credentialBindingsFor([source])).toEqual([{ action: "checkout", handle: source, provider: source, name: source === "github" ? "github-read" : source, locator: "tenant" }]);
  }
  for (const workflow of [reviewerGithub, reviewerBitbucket]) {
    const definition = JSON.stringify(projectLiveToInert(workflow));
    expect(definition).toContain('"find"');
    expect(definition).toContain('"check"');
    expect(definition).toContain('"report"');
    for (const removed of ["plan", "findRepo", "consolidate", "write", "writeInput"]) expect(definition).not.toContain(`"${removed}"`);
  }
});

test("a malformed finder answer retries rather than becoming a clean review", async () => {
  diffFinderProse = 1;
  const { run } = await review(join(dir, "data"));
  expect(diffFinderProse).toBe(0);
  expect(run.terminalStatus).toBe("completed");
  expect(run.outputs["review"]).toMatchObject({ complete: true, comments: [{ path: FINDING.path, start: FINDING.start }] });
});

test("a missing checkout leaves the review unfinished", async () => {
  const { run } = await review(join(dir, "here"), join(dir, "elsewhere"));
  expect(run.terminalStatus).not.toBe("completed");
  expect(run.outputs["review"]).toBeUndefined();
});

test("a failed finder iteration prevents review output after its retries", async () => {
  finderRefused = true;
  try {
    const { run, attempts } = await review(join(dir, "data"));
    expect(run.terminalStatus).not.toBe("completed");
    expect(attempts["code-review-finder"]).toBe(3);
    expect(run.outputs["review"]).toBeUndefined();
  } finally {
    finderRefused = false;
  }
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
