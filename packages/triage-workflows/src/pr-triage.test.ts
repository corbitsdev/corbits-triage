import { describe, expect, test } from "bun:test";
import { createSizeCapTransform } from "@intx/inference";
import { runLocal, type ActionHandler, type OnTriggerPrimitive, type StepInvoker, type WorkflowAuthorizeFn } from "@intx/workflow";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState, ToolCall, ToolResult } from "@intx/types/runtime";
import { doMarker } from "@corbits/github-tool/do";
import { REPO_DOCS_MAX_BYTES, REPO_RULES_MAX_BYTES, type GithubFetch } from "@corbits/github-reads";
import { ACTION_KINDS, defaultActions, emptyPack, recommendedPack, type ActionKind, type CheckPack, type CustomCheck, type Step, type PolicyActions, type PolicySource } from "@corbits/triage-contracts";
import * as actions from "./actions/index.js";
import { triageDirectorFactory, type DoResult } from "./directors.js";
import type { SuggestedDo } from "./logic/actions.js";
import { MAX_SYSTEM_ONE_STATE_BYTES } from "./logic/quality.js";
import { RULES_PASS_REASON, type Verdict } from "./logic/render.js";
import { workflow } from "./pr-triage.js";
import { workflow as historical } from "./pr-triage-historical.js";

const REPO = "acme/widgets";
const HI: Step[] = [{ do: "comment", target: { body: "hi" } }];
const HELLO: PolicyActions = { ...defaultActions(), pass: HI, fail: HI, unsure: HI };
const APPROVE: PolicyActions = { ...defaultActions(), when: ["opened", "updated"], pass: [{ do: "approve" }] };
const REQUEST_CHANGES: PolicyActions = { ...defaultActions(), fail: [{ do: "request-changes" }] };
const APP = { login: "corbits-triage[bot]", type: "Bot" };

type Recorded = { method: string; path: string };
type FileRow = { filename: string; status: string; additions: number; deletions: number; patch?: string; previous_filename?: string };

const FLAG: FileRow = { filename: "src/flag.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const flag = true;" };

const README = `Run \`bun run dev\` to start.\n${"Read the guide.\n".repeat(500)}`;
const GUIDE = "設定を確認してください。\n".repeat(600);
const AGENTS = "Every change needs a test.\n";
const CONTRIBUTING = "One concern per pull request.\n".repeat(400);
// Together over the docs cap and several tool results long, with a multibyte doc split across pages; the contribution
// rules fall outside it and, over their own cap, are read again apart from it.
const DOCS = [["README.md", README], ["docs/guide.md", GUIDE], ["vendor/lib/README.md", "Vendored."], ["CHANGELOG.md", "Changes."], ["AGENTS.md", AGENTS], [".github/CONTRIBUTING.md", CONTRIBUTING]] as const;

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

type Comment = { id: number; user: { login?: string; type: string }; body: string; updated_at?: string };
type Review = { id: number; user: { login: string; type: string }; state: string; commit_id: string; body: string };
type Ci = "none" | "pending" | "success" | "failure";

const RUNS: Record<Ci, unknown[]> = {
  none: [],
  pending: [{ name: "build", status: "in_progress", conclusion: null }],
  success: [{ name: "build", status: "completed", conclusion: "success" }],
  failure: [{ name: "build", status: "completed", conclusion: "failure" }],
};
type GithubSeed = { missing?: boolean; files?: FileRow[]; labels?: string[]; prior?: string; failComments?: boolean };

function fakeGithub({ missing = false, files = [FLAG], labels = [], prior, failComments = false }: GithubSeed = {}) {
  const requests: Recorded[] = [];
  const comments: Comment[] = prior === undefined ? [] : [{ id: 5, user: APP, body: prior }];
  const reviews: Review[] = [];
  const pr: { head: string; draft: boolean; ci: Ci; dismissible: boolean } = { head: "abc", draft: false, ci: "none", dismissible: true };
  async function gh(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    requests.push({ method, path });
    if (missing && path.includes("/pulls/8")) return Response.json({ message: "Not Found" }, { status: 404 });
    if (path.startsWith(`/repos/${REPO}/pulls?`)) return Response.json([{ number: 8, title: "Fix #3", user: { login: "octocat" }, draft: pr.draft, head: { sha: pr.head } }]);
    if (path === `/repos/${REPO}/pulls/8`) {
      return Response.json({ number: 8, title: "Fix #3", state: "open", draft: pr.draft, user: { login: "octocat" }, head: { sha: pr.head, ref: "fix" }, base: { ref: "main" }, mergeable: true, labels: labels.map((name) => ({ name })), requested_reviewers: [{ login: "rev" }] });
    }
    if (path.includes("/check-runs")) return Response.json({ check_runs: RUNS[pr.ci] });
    if (path === `/repos/${REPO}`) return Response.json({ default_branch: "main" });
    if (path.startsWith(`/repos/${REPO}/git/trees/`)) return Response.json({ sha: "tree", tree: DOCS.map(([doc, text], index) => ({ path: doc, type: "blob", sha: `blob${index}`, size: bytes(text) })) });
    if (path.startsWith(`/repos/${REPO}/git/blobs/blob`)) return new Response(DOCS[Number(path.slice(path.lastIndexOf("blob") + 4))]![1]);
    if (path.startsWith(`/repos/${REPO}/pulls/8/files`)) {
      const page = Number(new URL(path, "https://api.github.invalid").searchParams.get("page"));
      return Response.json(files.slice((page - 1) * 100, page * 100));
    }
    if (path.startsWith(`/repos/${REPO}/issues/8/comments?`)) return Response.json(comments);
    if (method === "POST" && path === `/repos/${REPO}/issues/8/comments`) {
      if (failComments) return Response.json({ message: "Server Error" }, { status: 500 });
      comments.push({ id: comments.length + 10, user: APP, body: JSON.parse(String(init?.body)).body, updated_at: `2026-10-13T00:00:${requests.length}Z` });
      return Response.json(comments.at(-1));
    }
    const edited = comments.find((comment) => method === "PATCH" && path === `/repos/${REPO}/issues/comments/${comment.id}`);
    if (edited) return Response.json(Object.assign(edited, { body: JSON.parse(String(init?.body)).body, updated_at: `2026-10-13T00:00:${requests.length}Z` }));
    if (path === "/app") return Response.json({ slug: "corbits-triage" });
    if (path.startsWith(`/repos/${REPO}/pulls/8/reviews?`)) return Response.json(reviews);
    if (method === "POST" && path === `/repos/${REPO}/pulls/8/reviews`) {
      const { commit_id, body, event } = JSON.parse(String(init?.body));
      reviews.push({ id: reviews.length + 100, user: APP, state: event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "APPROVED", commit_id, body });
      return Response.json(reviews.at(-1));
    }
    const dismissal = /^\/repos\/acme\/widgets\/pulls\/8\/reviews\/(\d+)\/dismissals$/.exec(path);
    if (method === "PUT" && dismissal) {
      if (!pr.dismissible) return Response.json({ message: "Forbidden" }, { status: 403 });
      const review = reviews.find((row) => row.id === Number(dismissal[1]));
      if (review) review.state = "DISMISSED";
      return Response.json(review);
    }
    if (method === "GET") return Response.json([]);
    return Response.json({});
  }
  return { gh: gh satisfies GithubFetch, requests, comments, reviews, pr };
}

const allow: WorkflowAuthorizeFn = async () => ({ effect: "allow", matchingGrants: [], resolvedBy: null });

type SystemOne = { questions: Array<{ id: string; instructions: string }>; state: { repository: { docs: Record<string, string>; rules?: Record<string, string> }; policy?: { rules: Array<Record<string, unknown>> } } };

function judgeText({ questions, state }: SystemOne) {
  function answer({ id }: { id: string }) {
    if (id === "verdict") {
      const failed = state.policy!.rules.some((rule) => rule.result === "fail");
      return { id, type: "choice", choice: failed ? "fail" : "pass", probabilities: { pass: failed ? 0.1 : 0.85, fail: failed ? 0.85 : 0.1, cant_tell: 0.05 }, confidence: 0.9 };
    }
    if (id.startsWith("custom-")) return { id, type: "noul", noul: 0.1 };
    if (/^focused-slice-\d+$/.test(id)) return { id, type: "choice", choice: "separate_change", probabilities: { serves_purpose: 0.2, separate_change: 0.7, cant_tell: 0.1 }, confidence: 0.9 };
    if (id !== "focused") return { id, type: "noul", noul: 0.9 };
    return { id, type: "choice", choice: "more_than_one_thing", probabilities: { one_thing: 0.2, more_than_one_thing: 0.7, cant_tell: 0.1 }, confidence: 0.9 };
  }
  return questions.map((q) => JSON.stringify(answer(q))).join("");
}

/** Under Interchange's tool-result cap. */
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
    const queue: ReactorInboundEvent[] = [{ type: "message.received", message: delivered(input) } as ReactorInboundEvent];
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

const RULES_PATH = { invoked: ["triage-facts", "triage-execute", "triage-mirror"], mirrors: ["mirrorRules"] };
// Without judged rules to ask first, the verdict question is the judge's only call.
const VERDICT_PATH = { invoked: ["triage-facts", "triage-judge", "triage-execute", "triage-mirror"], mirrors: ["mirror"] };
// `judgeText` fails focused, so the judge is called again for its file questions; a failed judged rule decides Fail without the verdict question.
const JUDGE_PATH = { invoked: ["triage-facts", "triage-judge", "triage-judge", "triage-execute", "triage-mirror"], mirrors: ["mirror"] };

type TriageOptions = GithubSeed & { backlog?: boolean; judgeFails?: boolean; automatic?: readonly ActionKind[]; from?: string; github?: ReturnType<typeof fakeGithub>; source?: PolicySource };

async function triage(checkPack: CheckPack, { backlog = false, judgeFails = false, automatic = ACTION_KINDS, from = "github@acme.test", github, source, ...seed }: TriageOptions = {}) {
  const { gh, requests } = github ?? fakeGithub(seed);
  const policy = { enabled: true, ...(source && { source }) };
  const invoked: string[] = [];
  const judged: SystemOne[] = [];
  const body = ((backlog ? historical : workflow).steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("triage body is not inline");
  const { terminalStatus, outputs } = await runLocal(body.inline, {
    authorize: allow,
    hasUpstreamSignalResolver: true,
    invokeStep: stepInvoker(gh, invoked, judged, judgeFails),
    actionResolver: (ref) => (actions as Record<string, ActionHandler>)[ref]!,
    triggerPayload: hubMail(backlog ? { kind: "backlog", repo: REPO, policy, checkPack, automatic } : { kind: "pr", repo: REPO, prNumber: 8, policy, checkPack, automatic, events: ["opened"] }, from),
  }).complete;
  expect(terminalStatus).toBe("completed");
  const mirrors = Object.keys(outputs).filter((id) => id.startsWith("mirror"));
  const executed = (outputs["execute"] ?? outputs["executeRules"]) as { reply: string };
  return { path: { invoked, mirrors }, mirrored: mirrors.map((id) => outputs[id]), requests, judged, verdict: outputs["evaluate"] ?? outputs["evaluateRules"], dos: (JSON.parse(executed.reply) as { dos: DoResult[] }).dos };
}

function hubMail(request: Record<string, unknown>, from: string) {
  return { headers: { from, to: ["run_1@acme.test"] }, parts: [{ contentType: "text/plain", text: JSON.stringify(request) }] };
}

/** The parsed headers, and the text part alone as `content`. */
function delivered(mail: Record<string, unknown>) {
  const parts = Array.isArray(mail.parts) ? mail.parts as Array<{ text?: string }> : [];
  return { headers: mail.headers, content: parts[0]?.text ?? JSON.stringify(mail) };
}

function approvalMail(verdict: Verdict, step: SuggestedDo, from = "github@acme.test") {
  return hubMail({
    kind: "approve-do", runId: "run_1", principalId: "prn_ann", list: step.list, index: step.index,
    request: verdict.request, step: { effectId: step.effectId, headSha: verdict.headSha, kind: step.kind, target: step.target },
  }, from);
}

async function approve(github: ReturnType<typeof fakeGithub>, mail: ReturnType<typeof approvalMail>) {
  const body = (workflow.steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("triage body is not inline");
  const invoked: string[] = [];
  const { terminalStatus, outputs } = await runLocal(body.inline, {
    authorize: allow,
    hasUpstreamSignalResolver: true,
    invokeStep: stepInvoker(github.gh, invoked, [], false),
    actionResolver: (ref) => (actions as Record<string, ActionHandler>)[ref]!,
    triggerPayload: mail,
  }).complete;
  const executed = outputs["executeApproved"] as { reply: string } | undefined;
  return { terminalStatus, invoked, dos: executed && (JSON.parse(executed.reply) as { dos: DoResult[] }).dos };
}

describe("pr-triage body", () => {
  test("a failed hard rule decides Fail without the judge and runs the fail list", async () => {
    const github = fakeGithub({ labels: ["bug", "triage:awaiting-review"] });
    github.pr.ci = "failure";
    const fails: CheckPack = { ...emptyPack(REPO), checks: { ci: { enabled: true }, docs: { enabled: true } }, actions: { ...defaultActions(), fail: HI } };
    const { path, requests, verdict } = await triage(fails, { github });
    expect(path).toEqual(RULES_PATH);
    expect(verdict).toMatchObject({ verdict: "fail", score: null, reasons: ["required checks are failing: build"], degraded: null, actions: [{ list: "fail", kind: "comment", target: { body: "hi" } }] });
    expect((verdict as Verdict).checks.find((c) => c.check === "docs")).toMatchObject({ result: "unconfirmed", reason: "not asked" });
    expect((verdict as Verdict).request.labels).toEqual(["Triage: Not Ready"]);
    expect((verdict as Verdict).request.comment).toBe("**Triage: Fail**\n\n@octocat, please address the following:\n- required checks are failing: `build`\n\nTriage will comment.");
    expect(requests).toContainEqual({ method: "POST", path: `/repos/${REPO}/issues/8/labels` });
    expect(requests.filter((r) => r.method === "DELETE")).toEqual([{ method: "DELETE", path: `/repos/${REPO}/issues/8/labels/triage%3Aawaiting-review` }]);
  });

  test("without a decision-model rule, every rule passing decides Pass without the model and its list runs", async () => {
    const { path, judged, verdict } = await triage({ ...emptyPack(REPO), checks: { "ci-green": { enabled: true } }, actions: HELLO });
    expect(path).toEqual(RULES_PATH);
    expect(judged).toEqual([]);
    expect(verdict).toMatchObject({ verdict: "pass", score: null, reason: RULES_PASS_REASON, reasons: [], actions: [{ list: "pass", kind: "comment" }] });
    expect((verdict as Verdict).request.labels).toEqual(["Triage: Ready"]);
  });

  test("the mirror writes the policy's own verdict label and takes back the defaults and the policy's other verdict labels", async () => {
    const labels = { pass: "Ship it", fail: "Triage: Not Ready", unsure: "Look at me" };
    const { verdict } = await triage({ ...emptyPack(REPO), checks: { "ci-green": { enabled: true } }, labels });
    expect((verdict as Verdict).request.labels).toEqual(["Ship it"]);
    expect((verdict as Verdict).request.owned).toEqual(expect.arrayContaining(["Triage: Ready", "Triage: Not Ready", "Triage: Needs Human Review", "Triage: Needs changes", "Ship it", "Look at me"]));
  });

  test("model checks run the judge on the repository's own docs and the verdict records its answers", async () => {
    const { path, judged, verdict } = await triage(recommendedPack(REPO));
    expect(path).toEqual(JUDGE_PATH);
    expect(judged.map((call) => call.questions.map((question) => question.id))).toEqual([["docs-file-001", "focused"], ["focused-file-001"]]);
    expect(verdict).toMatchObject({ verdict: "fail", score: null, reasons: ["mixes unrelated changes: src/flag.ts", "documentation is not updated: src/flag.ts"] });
    expect(judged[0]!.state.repository).not.toHaveProperty("rules");
    const { "README.md": readme, "docs/guide.md": guide, ...rest } = judged[0]!.state.repository.docs;
    expect(readme).toBe(README);
    expect(GUIDE.startsWith(guide!)).toBe(true);
    const read = bytes(readme!) + bytes(guide!);
    expect(read).toBeGreaterThan(REPO_DOCS_MAX_BYTES - 3);
    expect(read).toBeLessThanOrEqual(REPO_DOCS_MAX_BYTES);
    expect(rest).toEqual({});
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => [c.check, c.result])).toEqual([["focused", "fail"], ["docs", "fail"]]);
    expect((verdict as Verdict).checks.find((c) => c.check === "focused")?.evidence).toEqual(["src/flag.ts"]);
    expect((verdict as Verdict).checks.find((c) => c.check === "docs")?.evidence).toEqual(["src/flag.ts"]);
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => c.output)).toEqual([
      { kind: "score", score: expect.closeTo(20), passAt: 60, items: ["src/flag.ts"] },
      { kind: "score", score: expect.closeTo(10), passAt: 70, items: ["src/flag.ts"] },
    ]);
  });

  test("a file list past the tool-result cap still shows the judge its docs changes", async () => {
    const sources = Array.from({ length: 150 }, (_, index) => ({ ...FLAG, filename: `src/modules/feature-${index}/index.ts` }));
    const files = [...sources, { ...FLAG, filename: "docs/flag.md" }];
    expect(JSON.stringify(files).length).toBeGreaterThan(10_000);
    const pack = emptyPack(REPO);
    const { judged, verdict } = await triage({ ...pack, checks: { docs: { enabled: true } } }, { files });
    expect(judged.flatMap((call) => call.questions.map((question) => question.id))).toEqual(["verdict"]);
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => [c.check, c.result])).toEqual([["docs", "pass"]]);
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => c.output)).toEqual([{ kind: "met", items: ["docs/flag.md"] }]);
  });

  test("a deleted doc does not cover the change, and a test file or a pure rename asks nothing", async () => {
    const removed = { filename: "docs/old.md", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-Old." };
    const renamed = { filename: "src/moved.ts", previous_filename: "src/kept.ts", status: "renamed", additions: 0, deletions: 0 };
    const { judged, verdict } = await triage({ ...emptyPack(REPO), checks: { docs: { enabled: true } } }, { files: [FLAG, removed, renamed, { ...FLAG, filename: "src/flag.test.ts" }] });
    expect(judged.flatMap((call) => call.questions.map((question) => question.id))).toEqual(["docs-file-001"]);
    expect((verdict as Verdict).checks.find((c) => c.check === "docs")).toMatchObject({ result: "fail", evidence: ["src/flag.ts"] });
  });

  test("a pull request past the decision model budget is judged in several calls on every model check", async () => {
    const sources = Array.from({ length: 45 }, (_, index) => ({
      ...FLAG,
      filename: `src/feature-${index}.ts`,
      patch: ["@@ -0,0 +1,41 @@", `+export const feature${index} = true;`, ...Array.from({ length: 40 }, (_, line) => `+// ${"evidence ".repeat(6)}${line}`)].join("\n"),
    }));
    expect(sources.reduce((total, file) => total + file.patch.length, 0)).toBeGreaterThan(MAX_SYSTEM_ONE_STATE_BYTES);
    const files = [...sources, { ...FLAG, filename: "docs/flag.md" }];
    const { path, verdict } = await triage(recommendedPack(REPO), { files });
    expect(path.invoked.filter((agent) => agent === "triage-judge").length).toBeGreaterThanOrEqual(2);
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => [c.check, c.result])).toEqual([["focused", "fail"], ["docs", "pass"]]);
    expect((verdict as Verdict).checks.find((c) => c.check === "focused")?.evidence).toHaveLength(3);
  });

  test("a scoped custom check fails naming the migration or change that breaks it and does not apply without one", async () => {
    const reversible: CustomCheck = { id: "custom-1", name: "Reversible", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "The migration can be rolled back.", scope: "file", when: ["migrations/**"] };
    const pack = { ...emptyPack(REPO), custom: [reversible] };
    const migration = { ...FLAG, filename: "migrations/001_users.sql", patch: "@@ -0,0 +1 @@\n+DROP TABLE users;" };
    const migrated = await triage(pack, { files: [FLAG, migration] });
    expect(migrated.judged.flatMap((call) => call.questions)).toEqual([
      { id: "custom-1-file-002", type: "boolean", instructions: "Does the change in `pullRequest.files[1]` meet this rule: The migration can be rolled back? Judge it by the pull request and the repository's contribution rules in `repository.rules`." },
    ]);
    const rules = migrated.judged[0]!.state.repository.rules!;
    expect(Object.keys(rules)).toEqual(["AGENTS.md", ".github/CONTRIBUTING.md"]);
    expect(rules["AGENTS.md"]).toBe(AGENTS);
    expect(CONTRIBUTING.startsWith(rules[".github/CONTRIBUTING.md"]!)).toBe(true);
    expect(bytes(AGENTS) + bytes(rules[".github/CONTRIBUTING.md"]!)).toBe(REPO_RULES_MAX_BYTES);
    expect((migrated.verdict as Verdict).checks.find((c) => c.check === "custom-1")).toMatchObject({
      result: "fail",
      evidence: ["migrations/001_users.sql"],
      output: { kind: "score", score: expect.closeTo(10), passAt: 70, items: ["migrations/001_users.sql"] },
    });
    const twice = { ...migration, patch: "@@ -0,0 +1 @@\n+DROP TABLE users;\n@@ -12,2 +11,0 @@\n-CREATE TABLE teams ();\n-CREATE TABLE orgs ();" };
    const hunks = await triage({ ...pack, custom: [{ ...reversible, scope: "hunk" }] }, { files: [FLAG, twice] });
    expect(hunks.judged.flatMap((call) => call.questions.map((question) => question.id))).toEqual(["custom-1-hunk-002-001", "custom-1-hunk-002-002"]);
    expect((hunks.verdict as Verdict).checks.find((c) => c.check === "custom-1")?.output).toMatchObject({
      items: [{ path: "migrations/001_users.sql", added: { start: 1, end: 1 } }, { path: "migrations/001_users.sql", removed: { path: "migrations/001_users.sql", start: 12, end: 13 } }],
    });
    expect((hunks.verdict as Verdict).feedback).toContain(`does not meet "Reversible": [\`migrations/001_users.sql:1\`](https://github.com/${REPO}/blob/abc/migrations/001_users.sql?plain=1#L1), \`migrations/001_users.sql (removed lines 12–13)\``);
    const unmigrated = await triage(pack);
    expect(unmigrated.path).toEqual(VERDICT_PATH);
    expect((unmigrated.verdict as Verdict).checks.find((c) => c.check === "custom-1")).toMatchObject({ result: "pass", reason: "does not apply", output: { kind: "not-applicable" } });
  });

  test("a role granted comment and labels posts a comment when the judge fails; one without them does not", async () => {
    const comment = { method: "POST", path: `/repos/${REPO}/issues/8/comments` };
    const automated = await triage(recommendedPack(REPO), { judgeFails: true });
    expect(automated.verdict).toMatchObject({ degraded: "inference-outage", mirror: true, verdict: "unsure", actions: [] });
    expect((automated.verdict as Verdict).request.comment).toContain("Triage will re-check this pull request.");
    expect(automated.requests).toContainEqual(comment);
    const approved = await triage(recommendedPack(REPO), { judgeFails: true, automatic: ["approve"] });
    expect(approved.verdict).toMatchObject({ degraded: "inference-outage", mirror: true });
    expect(approved.requests).not.toContainEqual(comment);
  });

  test("a re-triage with nothing left to fix replaces the earlier needs list with the approval note", async () => {
    const { requests, verdict } = await triage(emptyPack(REPO), { prior: "<!-- corbits-triage -->\n@octocat, please address the following:\n- Link an issue" });
    expect((verdict as Verdict).request.comment).toBe("**Triage: Pass**\n\nNo changes needed from you. A maintainer will review this pull request.");
    expect(requests).toContainEqual({ method: "PATCH", path: `/repos/${REPO}/issues/comments/5` });
  });

  test("a rerun of the same head and policy leaves the comment alone; new rules that change its verdict supersede it", async () => {
    const github = fakeGithub();
    github.pr.ci = "failure";
    const v1 = { repo: { id: "policy-1", version: 1 } };
    const v2 = { repo: { id: "policy-1", version: 2 } };
    await triage(emptyPack(REPO), { github, source: v1 });
    const again = await triage(emptyPack(REPO), { github, source: v1 });
    expect(again.mirrored).toEqual([expect.objectContaining({ reply: expect.stringContaining("unchanged since") })]);
    const strict = await triage({ ...emptyPack(REPO), checks: { "ci-green": { enabled: true } } }, { github, source: v2 });
    expect(strict.verdict).toMatchObject({ verdict: "fail" });
    const commentWrites = github.requests.filter((r) => r.method !== "GET" && r.path.includes("comments"));
    expect(commentWrites).toEqual([
      { method: "POST", path: `/repos/${REPO}/issues/8/comments` },
      { method: "PATCH", path: `/repos/${REPO}/issues/comments/10` },
      { method: "POST", path: `/repos/${REPO}/issues/8/comments` },
    ]);
    expect(github.comments.map((comment) => comment.body.split("\n")[1])).toEqual([
      "Superseded by the comment below.",
      "This supersedes the comment above because the rules changed: repository policy version 1 → version 2.",
    ]);
  });

  test("an automated repository runs a Do whose kind the pr-triage role is granted once per head", async () => {
    const github = fakeGithub();
    const pack = { ...emptyPack(REPO), actions: HELLO };
    const first = await triage(pack, { github });
    const effectId = ((first.verdict as Verdict).actions[0] as SuggestedDo).effectId;
    expect(first.dos).toEqual([{ effectId, status: "done" }]);
    const again = await triage(pack, { github });
    expect(again.dos).toEqual([{ effectId, status: "satisfied" }]);
    expect(github.comments.filter((c) => c.body.includes("corbits-do:"))).toEqual([expect.objectContaining({ body: `${doMarker(effectId)}\nhi` })]);
  });

  test.each<[string, TriageOptions]>([
    ["the pr-triage role is not granted", { automatic: ["labels"] }],
    ["only a mail from anyone but the hub's sender grants", { from: "mallory@acme.test" }],
  ])("a Do whose kind %s is held", async (_, options) => {
    const { dos, verdict } = await triage({ ...emptyPack(REPO), actions: HELLO }, options);
    expect((verdict as Verdict).actions).toEqual([expect.objectContaining({ list: "pass", held: true })]);
    expect(dos).toEqual([]);
  });

  test("a held Do is written once by the hub's approval mail and never on a later head", async () => {
    const github = fakeGithub();
    const { dos, verdict } = await triage({ ...emptyPack(REPO), actions: HELLO }, { github, automatic: [] });
    const held = (verdict as Verdict).actions[0] as SuggestedDo;
    expect(held).toMatchObject({ list: "pass", held: true });
    expect(dos).toEqual([]);
    const mail = approvalMail(verdict as Verdict, held);
    const first = await approve(github, mail);
    expect(first).toMatchObject({ terminalStatus: "completed", invoked: ["triage-execute"], dos: [{ effectId: held.effectId, status: "done" }] });
    expect((await approve(github, mail)).dos).toEqual([{ effectId: held.effectId, status: "satisfied" }]);
    expect(github.comments.filter((c) => c.body.includes("corbits-do:"))).toEqual([expect.objectContaining({ body: `${doMarker(held.effectId)}\nhi` })]);
    const forged = approvalMail(verdict as Verdict, { ...held, target: { body: "spam" } });
    expect((await approve(github, forged)).dos).toEqual([{ effectId: held.effectId, status: "skipped", error: "the approval's effect id does not match its Do" }]);
    const unreadable = approvalMail(verdict as Verdict, { ...held, kind: "bogus" as never });
    expect((await approve(github, unreadable)).dos).toEqual([{ effectId: held.effectId, status: "skipped", error: expect.stringContaining("invalid Do") }]);
    github.pr.head = "def";
    expect((await approve(github, mail)).dos).toEqual([{ effectId: held.effectId, status: "skipped", error: expect.stringContaining("has new commits") }]);
  });

  test("an approval mail from anyone but the hub's sender writes nothing", async () => {
    const github = fakeGithub();
    const { verdict } = await triage({ ...emptyPack(REPO), actions: HELLO }, { github, automatic: [] });
    const denied = await approve(github, approvalMail(verdict as Verdict, (verdict as Verdict).actions[0] as SuggestedDo, "mallory@acme.test"));
    expect(denied).toMatchObject({ terminalStatus: "completed", dos: undefined });
    expect(github.comments.filter((c) => c.body.includes("corbits-do:"))).toEqual([]);
  });

  function approving() {
    const github = fakeGithub();
    github.pr.ci = "success";
    return { github, pack: { ...emptyPack(REPO), checks: { "no-merge-conflicts": { enabled: true } }, actions: APPROVE } };
  }

  function appReads(github: ReturnType<typeof fakeGithub>): number {
    return github.requests.filter((r) => r.path === "/app").length;
  }

  test("every check passing with CI green approves the head once, pinned to it, asking for the App once a step", async () => {
    const { github, pack } = approving();
    const first = await triage(pack, { github });
    const effectId = ((first.verdict as Verdict).actions[0] as SuggestedDo).effectId;
    expect(first.dos).toEqual([{ effectId, status: "done" }]);
    expect(appReads(github)).toBe(2);
    expect((await triage(pack, { github })).dos).toEqual([{ effectId, status: "satisfied" }]);
    expect(github.reviews).toEqual([expect.objectContaining({ state: "APPROVED", commit_id: "abc" })]);
  });

  test.each<[string, (github: ReturnType<typeof fakeGithub>) => void, string]>([
    ["a failing check", (github) => { github.pr.draft = true; }, ""],
    ["pending CI", (github) => { github.pr.ci = "pending"; }, "CI has not passed on this head."],
  ])("%s approves nothing", async (_, change, reason) => {
    const { github, pack } = approving();
    change(github);
    const { dos, verdict } = await triage(pack, { github });
    expect(dos).toEqual([]);
    expect((verdict as Verdict).actions).toEqual(reason ? [expect.objectContaining({ kind: "approve", skipped: true, reason })] : []);
    expect(github.reviews).toEqual([]);
  });

  test("an approve Do on the fail list does not approve a pull request that fails its policy", async () => {
    const { github, pack } = approving();
    const forbidden = { ...pack, checks: { ...pack.checks, "no-forbidden-paths": { enabled: true, forbiddenGlobs: ["src/**"] } }, actions: { ...APPROVE, fail: APPROVE.pass } };
    const { dos, verdict } = await triage(forbidden, { github });
    expect((verdict as Verdict).verdict).toBe("fail");
    expect((verdict as Verdict).actions).toEqual([expect.objectContaining({ kind: "approve", skipped: true, reason: "The pull request does not pass its policy." })]);
    expect(dos).toEqual([]);
    expect(github.reviews).toEqual([]);
  });

  test("new commits that may not be approved take back the approve Do's approval of the earlier head, once", async () => {
    const { github, pack } = approving();
    await triage(pack, { github });
    github.pr.head = "def";
    github.pr.draft = true;
    await triage(pack, { github });
    await triage(pack, { github });
    expect(github.reviews).toEqual([expect.objectContaining({ commit_id: "abc", state: "DISMISSED" })]);
    expect(github.requests.filter((r) => r.method === "PUT")).toEqual([{ method: "PUT", path: `/repos/${REPO}/pulls/8/reviews/100/dismissals` }]);
  });

  test("CI failing on a re-run takes back the approval of the same head, and green again does not approve it again", async () => {
    const { github, pack } = approving();
    await triage(pack, { github });
    github.pr.ci = "failure";
    await triage(pack, { github });
    expect(github.reviews).toEqual([expect.objectContaining({ commit_id: "abc", state: "DISMISSED" })]);
    github.pr.ci = "success";
    const green = await triage(pack, { github });
    expect(green.dos).toEqual([expect.objectContaining({ status: "satisfied" })]);
    expect(github.reviews).toHaveLength(1);
  });

  function requesting() {
    const github = fakeGithub();
    github.pr.ci = "failure";
    return { github, pack: { ...emptyPack(REPO), checks: { "ci-green": { enabled: true } }, actions: REQUEST_CHANGES } };
  }

  test("failing CI requests changes on the head once; a later head with CI fixed takes the request back", async () => {
    const { github, pack } = requesting();
    await triage(pack, { github });
    await triage(pack, { github });
    expect(github.reviews).toEqual([expect.objectContaining({ commit_id: "abc", state: "CHANGES_REQUESTED", body: expect.stringContaining("Triage requests changes:\n- ") })]);
    github.pr.head = "def";
    github.pr.ci = "success";
    await triage(pack, { github });
    expect(github.reviews).toEqual([expect.objectContaining({ commit_id: "abc", state: "DISMISSED" })]);
  });

  test("a head that fails requests changes; a later head that passes merges, and the mirror takes the earlier request back", async () => {
    const { github, pack } = requesting();
    const merging = { ...pack, actions: { ...pack.actions, pass: [{ do: "merge" as const }] } };
    await triage(merging, { github });
    github.pr.head = "def";
    github.pr.ci = "success";
    await triage(merging, { github });
    const writes = github.requests.filter((request) => request.method === "PUT").map((request) => request.path);
    expect(writes).toEqual([`/repos/${REPO}/pulls/8/merge`, `/repos/${REPO}/pulls/8/reviews/100`, `/repos/${REPO}/pulls/8/reviews/100/dismissals`]);
  });

  test("a dismissal GitHub refuses leaves the request standing without failing the mirror", async () => {
    const { github, pack } = requesting();
    await triage(pack, { github });
    github.pr.head = "def";
    github.pr.ci = "success";
    github.pr.dismissible = false;
    const { mirrored } = await triage(pack, { github });
    expect(JSON.stringify(mirrored)).toContain("changeRequestsKept");
    expect(github.reviews).toEqual([expect.objectContaining({ state: "CHANGES_REQUESTED" })]);
  });

  test.each<[string, CheckPack]>([
    ["a pack that approves", approving().pack],
    ["a pack without actions", emptyPack(REPO)],
  ])("an inbox approval of an earlier head stays under %s", async (_, pack) => {
    const github = fakeGithub();
    github.pr.head = "def";
    github.pr.draft = true;
    github.reviews.push({ id: 7, user: APP, state: "APPROVED", commit_id: "abc", body: "" });
    await triage({ ...pack, checks: { "no-merge-conflicts": { enabled: true } } }, { github });
    expect(github.reviews).toEqual([expect.objectContaining({ id: 7, state: "APPROVED" })]);
    expect(github.requests.filter((r) => r.method === "PUT")).toEqual([]);
  });

  test("a pack without an approve Do never asks for the App", async () => {
    const github = fakeGithub();
    github.pr.draft = true;
    await triage({ ...emptyPack(REPO), checks: { "no-merge-conflicts": { enabled: true } } }, { github });
    expect(appReads(github)).toBe(0);
  });

  test("a Do GitHub refuses is reported failed with its error and stays suggested on the verdict", async () => {
    const { dos, verdict } = await triage({ ...emptyPack(REPO), actions: HELLO }, { failComments: true });
    const effectId = ((verdict as Verdict).actions[0] as SuggestedDo).effectId;
    expect((verdict as Verdict).actions).toEqual([expect.objectContaining({ list: "pass", effectId })]);
    expect(dos).toEqual([{ effectId, status: "failed", error: `github POST /repos/${REPO}/issues/8/comments -> 500` }]);
  });

  test("facts that fail degrade the verdict and suggest no actions", async () => {
    const { path, verdict } = await triage({ ...recommendedPack(REPO), actions: HELLO }, { missing: true });
    expect(path).toEqual(RULES_PATH);
    expect(verdict).toMatchObject({ degraded: "error", reason: "github_get_pr failed for #8", actions: [] });
  });

  test("a backlog judges the listed pull requests and evaluates them as one batch", async () => {
    const { path, verdict } = await triage(recommendedPack(REPO), { backlog: true });
    expect(path).toEqual(JUDGE_PATH);
    expect(verdict).toMatchObject({ items: [{ number: 8, degraded: null }], summary: { total: 1 } });
  });
});
