import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectLiveToInert, type StepInvokeRequest, type WorkflowAuthorizeFn } from "@intx/workflow";
import { checkoutUnder } from "@corbits/pr-code-review/actions/checkout";
import { codeReviewAgents } from "@corbits/pr-code-review/agents";
import { codeReviewDirectors } from "@corbits/pr-code-review/directors";
import { ANTHROPIC } from "@corbits/pr-code-review-anthropic/profile";
import { APPROVE_DO_KIND, checkPolicyFile, emptyPack, stockTriggerMail, VERDICTS, type ActionKind, type CheckPack } from "@corbits/triage-contracts";
import type { SuggestedDo } from "@corbits/triage-workflows/logic/actions";
import type { Verdict } from "@corbits/triage-workflows/logic/render";
import { triageJudgeDirector } from "@corbits/triage-workflows/directors";
import type { Snapshot } from "@corbits/triage-workflows/evals/cases";
import { PR_TRIAGE, recordingGithub } from "@corbits/triage-workflows/evals/run-definition";
import { runLocalWorkflow } from "@corbits/triage-workflows/evals/run-local";
import { fixtureGithub, triggerMail } from "@corbits/triage-workflows/evals/serve";
import * as actions from "./actions/index.js";
import { workflow as bitbucket } from "./pr-workflow-bitbucket-datacenter.js";
import { workflow as github } from "./pr-workflow-github.js";
import { scopeOf } from "./actions/code-review.js";
import { severityOf } from "./actions/decide.js";
import { credentialBindingsFor, prWorkflowOf } from "./pr-workflow.js";

// joho/godotenv#262 as GitHub served it; its head is checked out from the new side of its patches.
const PR = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/godotenv-262.json"), "utf8")) as Snapshot;
const HEAD = "b724238db6209280ed96a4e04aa2af38063763d9";
const PACK = { ...emptyPack(PR.repo), checks: { focused: { enabled: true }, docs: { enabled: true } } };

function newSide(patch: string): string {
  const lines = patch.split("\n").filter((line) => !line.startsWith("@@") && !line.startsWith("-"));
  return `${lines.map((line) => line.slice(1)).join("\n")}\n`;
}

const FILES = Object.fromEntries(PR.files.map((file) => [file.filename, newSide(file.patch!)]));
const DIFF = PR.files.map((file) => `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}\n`).join("");
const QUOTED = FILES["parser.go"]!.split("\n").findIndex((line) => line.includes("escaped only"));
const FINDING = { path: "parser.go", start: QUOTED + 1, end: QUOTED + 1, priority: 0, confidence: 0.9, title: "odd count", why: "an even run of backslashes", trigger: "FOO=\"a\\\\\\\"\"", code: FILES["parser.go"]!.split("\n")[QUOTED] };
const REVIEW_REQUEST = { kind: "code-review", number: PR.number, title: PR.title, description: PR.body, diff: DIFF, checkout: { source: "github", repo: PR.repo, sha: HEAD } };

let dir: string;
let tarball: Uint8Array;
let model: ReturnType<typeof Bun.serve>;

const allow: WorkflowAuthorizeFn = async function allow() {
  return { effect: "allow", matchingGrants: [], resolvedBy: null };
};

type Question = { type: string; criteria?: Record<string, unknown> };

/** System One's answers, by question id: the passing choice where one is offered, else the first; true for a claim. */
function systemOne(questions: Record<string, Question>) {
  function answer([id, { type, criteria }]: [string, Question]) {
    if (type !== "choice") return [id, { type: "noul", noul: 0.9 }];
    const options = Object.keys(criteria ?? {});
    const choice = options.find((option) => ["pass", "one_thing", "serves_purpose"].includes(option)) ?? options[0]!;
    const probabilities = Object.fromEntries(options.map((option) => [option, option === choice ? 0.9 : 0.1 / (options.length - 1)]));
    return [id, { type, choice, probabilities, confidence: 0.9 }];
  }
  return { answers: Object.fromEntries(Object.entries(questions).map(answer)), model: "jev", usage: { input_tokens: 10, output_tokens: 1 } };
}

/** Each code review step's answer by its prompt: one finding from both finders, grouped alone and written up. */
function anthropic(body: { system: unknown; messages: unknown[] }) {
  const system = JSON.stringify(body.system);
  const sent = JSON.stringify(body.messages);
  let text: unknown = { findings: [FINDING] };
  if (system.includes("<cited_code>")) text = { groups: [{ defect: "odd count", members: [0], representative: 0 }] };
  if (sent.includes("Plan the review")) text = { areas: [], outside_diff: [] };
  if (sent.includes("Write the review.")) text = { summary: "One defect.", comments: [{ finding: 0, title: "odd count", body: "Count the run." }] };
  return [{ type: "text", text: JSON.stringify(text) }];
}

beforeAll(function serve() {
  dir = mkdtempSync(join(tmpdir(), "pr-workflow-"));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, "head", path)), { recursive: true });
    writeFileSync(join(dir, "head", path), text);
  }
  execFileSync("tar", ["-czf", join(dir, "head.tgz"), "-C", dir, "head"], { env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" } });
  tarball = readFileSync(join(dir, "head.tgz"));
  model = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string; questions: Record<string, Question>; system: unknown; messages: unknown[] };
      if (new URL(req.url).pathname === "/systemone") return Response.json(systemOne(body.questions));
      const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      return Response.json({ id: "msg", type: "message", role: "assistant", model: body.model, content: anthropic(body), stop_reason: "end_turn", stop_sequence: null, usage });
    },
  });
});

afterAll(function stop() {
  model.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

/** The fixture's reads, its head's tarball and files for code review, and every write recorded and answered. */
function host(writes: Write[]) {
  const served = fixtureGithub(PR, {});
  const repo = `/repos/${PR.repo}`;
  async function read(url: URL): Promise<Response> {
    if (url.pathname === `${repo}/tarball/${HEAD}`) return new Response(tarball);
    if (url.pathname.startsWith(`${repo}/commits/`)) return Response.json({ check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
    const file = FILES[url.pathname.slice(`${repo}/contents/`.length)];
    return file === undefined ? served(url) : new Response(file);
  }
  return recordingGithub(read, writes);
}

function sourceFor(req: StepInvokeRequest) {
  const origin = `http://localhost:${model.port}`;
  if (req.agent.id === "triage-judge") {
    return { id: req.agent.id, provider: "corbits-system-one", baseURL: origin, credentialId: "inference", model: "jev", quirks: { endpoint: { kind: "custom", url: `${origin}/systemone`, model: "jev" } } };
  }
  return { id: req.agent.id, provider: "anthropic", baseURL: origin, credentialId: "inference", model: req.agent.inference.sources[0]!.model };
}

type Write = { method: string; path: string; body: unknown };

type RunOptions = { pack?: CheckPack; automatic?: ActionKind[]; actions?: Record<string, unknown>; mail?: unknown };

/**
 * Runs one definition on the fixture's opened mail with `extra` beside its request, `automatic` the kinds it may run
 * unattended and `actions` in place of its own, or on `mail`; checkouts go under the test's folder.
 */
async function run(definition: typeof PR_TRIAGE, extra: Record<string, unknown> = {}, { pack = PACK, automatic = [], actions: overrides = {}, mail }: RunOptions = {}) {
  const writes: Write[] = [];
  const result = await runLocalWorkflow({
    ...definition,
    actions: { ...definition.actions, checkout: checkoutUnder(() => join(dir, "data")), ...overrides },
    authorize: allow,
    github: host(writes),
    inference: { credentialId: "inference", origin: `http://localhost:${model.port}`, apiKey: "local" },
    sourceFor,
    triggerPayload: mail ?? triggerMail(PR, pack, extra, automatic),
  });
  const ran = result.events.flatMap((event) => (event.kind === "StepCompleted" && event.stepId in result.outputs ? [event.stepId] : []));
  return { ...result, ran, writes };
}

function variant() {
  function dataDir() {
    return join(dir, "data");
  }
  const directors = codeReviewDirectors(ANTHROPIC, dataDir);
  const workflow = prWorkflowOf(codeReviewAgents(ANTHROPIC, directors, dataDir))({ sources: ["github"] });
  return { workflow, directors: [triageJudgeDirector.factory, ...Object.values(directors).map((d) => d.factory)], actions, credentialBindings: credentialBindingsFor(["github"]) };
}

const REVIEW_STEPS = ["reviewInput", "plan", "checkout", "findersInput", "findDiff", "findRepo", "candidates", "consolidate", "checks", "check", "writeInput", "write", "review"].map((id) => `codeReview_${id}`);

/** Code review as the hub fills it from the policy, for everyone on any verdict. */
const ON = { on: true, for: ["everyone"], triage: [...VERDICTS] };

function triageOf(ran: readonly string[]) {
  return ran.filter((id) => !id.startsWith("codeReview") && id !== "decide");
}

function at(events: readonly { kind: string; stepId?: string }[], kind: string, stepId: string): number {
  return events.findIndex((event) => event.kind === kind && event.stepId === stepId);
}

test("every deployed PR workflow requires a sidecar of its own", () => {
  for (const definition of [github, bitbucket]) {
    expect(projectLiveToInert(definition).sidecarPlacement).toEqual({ capabilities: [{ capability: "isolation:workload", effect: "require" }] });
  }
});

test("triage decides as pr-triage does, code review in scope records its findings, and triage executes only after it", async () => {
  const alone = await run(PR_TRIAGE);
  const composed = await run(variant(), { codeReview: { ...ON, triage: ["pass"], paths: ["*.go", "**/*.go"] }, codeReviewRequest: REVIEW_REQUEST });
  expect(composed.terminalStatus).toBe("completed");
  expect(triageOf(composed.ran)).toEqual(alone.ran);
  expect(composed.outputs["evaluate"]).toEqual(alone.outputs["evaluate"]);
  expect(composed.outputs["execute"]).toEqual(alone.outputs["execute"]);
  expect(composed.ran.filter((id) => id.startsWith("codeReview_")).sort()).toEqual(["codeReview_scope", "codeReview_gate", ...REVIEW_STEPS].sort());
  expect(composed.outputs["codeReview"]).toMatchObject({ outcome: "findings", review: { comments: [{ path: "parser.go", start: FINDING.start, title: "odd count", agreement: { finders: 2 } }] } });
  expect(at(composed.events, "StepStarted", "execute")).toBeGreaterThan(at(composed.events, "StepCompleted", "codeReview"));
});

/** A pass approves and merges, and the role may do both unattended. */
const APPROVING = { pack: { ...PACK, actions: { ...PACK.actions, pass: [{ do: "approve" as const }, { do: "merge" as const }] } }, automatic: ["approve" as const, "merge" as const] };

function approved(writes: readonly Write[]): boolean {
  return writes.some((write) => write.method === "POST" && write.path === `/repos/${PR.repo}/pulls/${PR.number}/reviews`);
}

function merged(writes: readonly Write[]): boolean {
  return writes.some((write) => write.path === `/repos/${PR.repo}/pulls/${PR.number}/merge`);
}

async function boom(): Promise<never> {
  throw new Error("boom");
}

/** The policy's decide rules: approve when every block that ran is clean, or on any pass. */
const ALL_CLEAN = [{ if: { all: "clean" }, do: "approve" }];
const ON_PASS = [{ if: { triage: "pass" }, do: ["approve", "merge"] }];

function held(dos: unknown, error: string) {
  expect((dos as { dos: unknown[] }).dos).toEqual([0, 1].map(() => ({ effectId: expect.any(String), status: "held", error })));
}

/** The hub's approval mail for the Do `effectId` the run's verdict named. */
function approvalMail(verdict: Verdict, effectId: string) {
  const step = verdict.actions.find((action) => "effectId" in action && action.effectId === effectId) as SuggestedDo;
  const request = { kind: APPROVE_DO_KIND, runId: "run_1", principalId: "prn_ann", list: step.list, index: step.index, request: verdict.request, step: { effectId, headSha: verdict.headSha, kind: step.kind, target: step.target } };
  return { ...triggerMail(PR, PACK), parts: [{ contentType: "text/plain", text: JSON.stringify(request) }] };
}

test("code review off runs none of its steps, records skipped, and the approve decide chose runs", async () => {
  const composed = await run(variant(), { codeReview: { ...ON, on: false }, codeReviewRequest: REVIEW_REQUEST, blocks: [], decide: ALL_CLEAN }, APPROVING);
  expect(composed.ran.filter((id) => id.startsWith("codeReview"))).toEqual(["codeReview_scope", "codeReview_gate", "codeReview"]);
  expect(composed.outputs["codeReview"]).toMatchObject({ outcome: "skipped", reason: "code review is off" });
  expect(approved(composed.writes)).toBe(true);
  expect(merged(composed.writes)).toBe(false);
});

test("after findings no rule matches, so approve and merge wait for a maintainer, whose approval mail writes the approve", async () => {
  const findings = await run(variant(), { codeReview: ON, codeReviewRequest: REVIEW_REQUEST, blocks: ["code-review"], decide: ALL_CLEAN }, APPROVING);
  expect(findings.outputs["codeReview"]).toMatchObject({ outcome: "findings" });
  expect(findings.outputs["decide"]).toMatchObject({ decision: { flag: "no rule matched" } });
  expect(approved(findings.writes) || merged(findings.writes)).toBe(false);
  held(findings.outputs["execute"], "Flagged for a maintainer: no rule matched.");
  const verdict = findings.outputs["evaluate"] as Verdict;
  const approve = verdict.actions.find((action) => action.kind === "approve") as SuggestedDo;
  const approval = await run(variant(), {}, { mail: approvalMail(verdict, approve.effectId) });
  expect(approval.ran).toContain("executeApproved");
  expect(approved(approval.writes)).toBe(true);
});

test("a v4 rule's own steps are the Dos that run: approve on a pass writes the approve, which the comment never claimed", async () => {
  const composed = await run(variant(), { codeReview: { ...ON, on: false }, codeReviewRequest: REVIEW_REQUEST, blocks: [], decide: [{ if: { triage: "pass" }, do: "approve" }] }, { automatic: ["approve"] });
  expect(composed.outputs["decide"]).toMatchObject({ decision: { do: "approve", rule: 0 } });
  expect(approved(composed.writes)).toBe(true);
  expect((composed.outputs["evaluate"] as Verdict).feedback).not.toContain("Triage will");
});

test("schema 3 actions beside code review on never approve or merge after a P0 finding, nor claim to in the comment; both wait for a maintainer", async () => {
  const file = checkPolicyFile("rules:\n  - { check: ci-green, text: CI passes., reason: Required., evidence: [maintainer-stated] }\ncode-review: { on: true }\nactions:\n  pass: [{ do: approve }, { do: merge }]\n", PR.repo);
  if (!file.ok) throw new Error(JSON.stringify(file.problems));
  const composed = await run(variant(), { codeReview: ON, codeReviewRequest: REVIEW_REQUEST, blocks: ["code-review"], decide: file.workflow.decide }, APPROVING);
  expect(composed.outputs["codeReview"]).toMatchObject({ outcome: "findings" });
  expect(composed.outputs["decide"]).toMatchObject({ decision: { rule: 1 } });
  expect(approved(composed.writes) || merged(composed.writes)).toBe(false);
  held(composed.outputs["execute"], "Code review is findings; a maintainer decides.");
  expect((composed.outputs["evaluate"] as Verdict).feedback).not.toContain("Triage will");
});

test("a finding's priority 0 to 3 reads as critical to low, and any other, or none, as critical", () => {
  expect([0, 3, 4, undefined].map((priority) => severityOf({ priority }))).toEqual(["critical", "low", "critical", "critical"]);
});

test("a review step that fails for good records the review incomplete, which holds a rule's approve and merge", async () => {
  const composed = await run(variant(), { codeReview: ON, codeReviewRequest: REVIEW_REQUEST, blocks: ["code-review"], decide: ON_PASS }, { ...APPROVING, actions: { writeInput: boom } });
  expect(composed.outputs["codeReview"]).toMatchObject({ outcome: "incomplete", reason: "the review did not finish" });
  expect(approved(composed.writes) || merged(composed.writes)).toBe(false);
  held(composed.outputs["execute"], "Flagged for a maintainer: a block is incomplete.");
});

test("a scope that fails records the review incomplete, and approve never runs", async () => {
  const composed = await run(variant(), { codeReview: ON, codeReviewRequest: REVIEW_REQUEST, blocks: ["code-review"], decide: ON_PASS }, { ...APPROVING, actions: { codeReviewScope: boom } });
  expect(composed.outputs["codeReview"]).toMatchObject({ outcome: "incomplete", reason: "the scope did not settle" });
  expect(approved(composed.writes)).toBe(false);
});

test("a decide step that fails fails triage's execute before it writes anything", async () => {
  const composed = await run(variant(), { codeReview: ON, codeReviewRequest: REVIEW_REQUEST, blocks: ["code-review"], decide: ON_PASS }, { ...APPROVING, actions: { decideActions: boom } });
  expect(composed.events.find((event) => event.kind === "StepFailed" && event.stepId === "execute")).toBeDefined();
  expect("execute" in composed.outputs).toBe(false);
  expect(approved(composed.writes)).toBe(false);
});

const GROUPS = { core: { users: ["octocat"] } };

function scope(codeReview: unknown, steps: Record<string, { output: unknown }>) {
  return scopeOf(stockTriggerMail({ kind: "pr", codeReview, codeReviewRequest: REVIEW_REQUEST, pack: { ...PACK, groups: GROUPS } }), steps);
}

type ChangedFile = { path: string; previousPath?: string };

function judged(author: Record<string, unknown>, files: ChangedFile[] = [{ path: "parser.go" }]) {
  return { evaluate: { output: { verdict: "pass" } }, facts: { output: { items: [{ facts: { changedFiles: files.length, files, authorTeams: [], authorTeamsUnknown: [], ...author } }] } } };
}

const MEMBER = { author: "octocat", authorKind: "MEMBER" };
const JUDGED = judged(MEMBER);

test("the scope runs for any group the author is in, on the verdicts and paths the policy names", () => {
  expect(scope({ ...ON, for: ["core"] }, JUDGED)).toEqual({ open: true, request: REVIEW_REQUEST });
  expect(scope({ ...ON, for: ["external"] }, judged({ author: "SAY-5", authorKind: "FIRST_TIME_CONTRIBUTOR" }))).toEqual({ open: true, request: REVIEW_REQUEST });
  expect(scope({ ...ON, for: ["external"] }, JUDGED)).toEqual({ open: false, outcome: "skipped", reason: "the author is in core, maintainers, everyone, not external" });
  expect(scope({ ...ON, triage: ["fail", "unsure"] }, JUDGED)).toEqual({ open: false, outcome: "skipped", reason: "triage is pass, not fail or unsure" });
  expect(scope({ ...ON, paths: ["docs/**"] }, JUDGED)).toEqual({ open: false, outcome: "skipped", reason: "no changed file matches docs/**" });
  const docsOnly = ["!*.md", "!docs/**", "!*.lock"];
  expect(scope({ ...ON, paths: docsOnly }, judged(MEMBER, [{ path: "README.md" }, { path: "docs/a.md" }, { path: "bun.lock" }]))).toEqual({ open: false, outcome: "skipped", reason: "no changed file matches !*.md, !docs/**, !*.lock" });
  expect(scope({ ...ON, paths: docsOnly }, judged(MEMBER, [{ path: "README.md" }, { path: "src/a.ts" }]))).toEqual({ open: true, request: REVIEW_REQUEST });
  expect(scope({ ...ON, paths: docsOnly }, judged(MEMBER, [{ path: "docs/a.ts", previousPath: "src/a.ts" }]))).toEqual({ open: true, request: REVIEW_REQUEST });
  expect(scope({ ...ON, paths: ["*.go", "!parser.go"] }, JUDGED)).toMatchObject({ open: false, outcome: "skipped" });
});

test("in doubt the scope never opens: what it cannot read leaves the review incomplete", () => {
  expect(scope({ ...ON, triage: "pass" }, JUDGED)).toMatchObject({ open: false, outcome: "incomplete" });
  expect(scope({ ...ON, for: ["core"] }, judged({ author: "octocat" }))).toEqual({ open: false, outcome: "incomplete", reason: "triage could not tell the author's groups" });
  const degraded = { evaluate: { output: { verdict: "unsure" } }, facts: { output: { items: [{ error: "not found" }] } } };
  const truncated = judged({ ...MEMBER, changedFiles: 3001 }, [{ path: "README.md" }]);
  expect(scope({ ...ON, paths: ["!*.md"] }, truncated)).toEqual({ open: false, outcome: "incomplete", reason: "triage could not read the changed files" });
  expect(scope({ ...ON, paths: ["!*.md"] }, degraded)).toEqual({ open: false, outcome: "incomplete", reason: "triage could not read the changed files" });
  expect(scope({ ...ON, paths: ["*.go"] }, degraded)).toEqual({ open: false, outcome: "incomplete", reason: "triage could not read the changed files" });
});
