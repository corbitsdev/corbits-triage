import { describe, expect, test } from "bun:test";
import { createSizeCapTransform } from "@intx/inference";
import { runLocal, type ActionHandler, type OnTriggerPrimitive, type StepInvoker, type WorkflowAuthorizeFn } from "@intx/workflow";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState, ToolCall, ToolResult } from "@intx/types/runtime";
import { doMarker } from "@corbits/github-tool/do";
import { REPO_DOCS_MAX_BYTES, REPO_RULES_MAX_BYTES, type GithubFetch } from "@corbits/github-tool/github";
import { ALL_CHECKS, emptyPack, recommendedPack, type Action, type CheckPack, type CustomCheck } from "@corbits/triage-contracts";
import * as actions from "./actions/index.js";
import { triageDirectorFactory, type DoResult } from "./directors.js";
import type { SuggestedDo } from "./logic/actions.js";
import { MAX_SYSTEM_ONE_STATE_BYTES } from "./logic/quality.js";
import type { Verdict } from "./logic/render.js";
import { workflow } from "./pr-triage.js";
import { workflow as historical } from "./pr-triage-historical.js";

const REPO = "acme/widgets";
const HELLO: Action = { id: "hello", when: "every", checks: [], branches: { always: [{ kind: "comment", automatic: false, target: { body: "hi" } }] } };
const AUTO_HELLO: Action = { ...HELLO, id: "auto-hello", branches: { always: [{ kind: "comment", automatic: true, target: { body: "hi" } }] } };
const APPROVE: Action = { id: "approve", when: ["opened", "updated"], checks: [ALL_CHECKS], branches: { yes: [{ kind: "approve", automatic: true, target: {} }] } };
const REQUEST_CHANGES: Action = { id: "ci-gate", when: "every", checks: ["ci"], branches: { no: [{ kind: "request-changes", automatic: true, target: {} }] } };
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

type Comment = { id: number; user: { type: string }; body: string };
type Review = { id: number; user: { login: string; type: string }; state: string; commit_id: string; body: string };
type Ci = "none" | "pending" | "success" | "failure";

const RUNS: Record<Ci, unknown[]> = {
  none: [],
  pending: [{ name: "build", status: "in_progress", conclusion: null }],
  success: [{ name: "build", status: "completed", conclusion: "success" }],
  failure: [{ name: "build", status: "completed", conclusion: "failure" }],
};
type GithubSeed = { missing?: boolean; files?: FileRow[]; labels?: string[]; prior?: string; failComments?: boolean };

/**
 * GitHub serving open pull request 8 at `pr.head`, a draft when `pr.draft` and with CI `pr.ci`, changing `files` and carrying `labels`, failing every read of it when `missing`,
 * keeping the comments and reviews posted on it, `prior` first, and refusing new comments when `failComments`.
 */
function fakeGithub({ missing = false, files = [FLAG], labels = [], prior, failComments = false }: GithubSeed = {}) {
  const requests: Recorded[] = [];
  const comments: Comment[] = prior === undefined ? [] : [{ id: 5, user: { type: "Bot" }, body: prior }];
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
      comments.push({ id: comments.length + 10, user: { type: "Bot" }, body: JSON.parse(String(init?.body)).body });
      return Response.json(comments.at(-1));
    }
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

type SystemOne = { questions: Array<{ id: string; instructions: string }>; state: { repository: { docs: Record<string, string>; rules?: Record<string, string> } } };

/** Calls the pull request and each slice of it a separate change, says no change meets a custom rule, and answers every other question yes, so each asked file is a separate change and needs docs and tests. */
function judgeText({ questions }: SystemOne) {
  function answer({ id }: { id: string }) {
    if (id.startsWith("custom-")) return { id, type: "noul", noul: 0.1 };
    if (/^focused-slice-\d+$/.test(id)) return { id, type: "choice", choice: "separate_change", probabilities: { serves_purpose: 0.2, separate_change: 0.7, cant_tell: 0.1 }, confidence: 0.9 };
    if (id !== "focused") return { id, type: "noul", noul: 0.9 };
    return { id, type: "choice", choice: "more_than_one_thing", probabilities: { one_thing: 0.2, more_than_one_thing: 0.7, cant_tell: 0.1 }, confidence: 0.9 };
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

const RULES_PATH = { invoked: ["triage-facts", "triage-execute", "triage-mirror"], mirrors: ["mirrorRules"] };
// `judgeText` fails focused, so the judge is called again for its file questions.
const JUDGE_PATH = { invoked: ["triage-facts", "triage-judge", "triage-judge", "triage-execute", "triage-mirror"], mirrors: ["mirror"] };

type TriageOptions = GithubSeed & { backlog?: boolean; judgeFails?: boolean; cleanupMode?: string; github?: ReturnType<typeof fakeGithub> };

async function triage(checkPack: CheckPack, { backlog = false, judgeFails = false, cleanupMode = "automated", github, ...seed }: TriageOptions = {}) {
  const { gh, requests } = github ?? fakeGithub(seed);
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
    triggerPayload: backlog ? { kind: "backlog", repo: REPO, policy, checkPack } : { kind: "pr", repo: REPO, prNumber: 8, policy, checkPack, events: ["opened"] },
  }).complete;
  expect(terminalStatus).toBe("completed");
  const mirrors = Object.keys(outputs).filter((id) => id.startsWith("mirror"));
  const executed = (outputs["execute"] ?? outputs["executeRules"]) as { reply: string };
  return { path: { invoked, mirrors }, mirrored: mirrors.map((id) => outputs[id]), requests, judged, verdict: outputs["evaluate"] ?? outputs["evaluateRules"], dos: (JSON.parse(executed.reply) as { dos: DoResult[] }).dos };
}

describe("pr-triage body", () => {
  test("without model checks the judge is skipped and the verdict carries the pack's actions", async () => {
    const { path, requests, verdict } = await triage({ ...emptyPack(REPO), actions: [HELLO] }, { labels: ["bug", "triage:awaiting-review"] });
    expect(path).toEqual(RULES_PATH);
    expect(verdict).toMatchObject({ repo: REPO, number: 8, headSha: "abc", degraded: null, actions: [{ id: "hello", kind: "comment", target: { body: "hi" } }] });
    expect((verdict as Verdict).request.labels).toEqual(["Triage: Ready to merge"]);
    expect(requests).toContainEqual({ method: "POST", path: `/repos/${REPO}/issues/8/labels` });
    expect(requests.filter((r) => r.method === "DELETE")).toEqual([{ method: "DELETE", path: `/repos/${REPO}/issues/8/labels/triage%3Aawaiting-review` }]);
  });

  test("model checks run the judge on the repository's own docs and the verdict records its answers", async () => {
    const { path, judged, verdict } = await triage(recommendedPack(REPO));
    expect(path).toEqual(JUDGE_PATH);
    expect(judged).toHaveLength(2);
    expect(judged[1]!.questions.map((question) => question.id)).toEqual(["focused-file-001"]);
    expect(judged[0]!.state.repository).not.toHaveProperty("rules");
    const { "README.md": readme, "docs/guide.md": guide, ...rest } = judged[0]!.state.repository.docs;
    expect(readme).toBe(README);
    expect(GUIDE.startsWith(guide!)).toBe(true);
    const read = bytes(readme!) + bytes(guide!);
    expect(read).toBeGreaterThan(REPO_DOCS_MAX_BYTES - 3);
    expect(read).toBeLessThanOrEqual(REPO_DOCS_MAX_BYTES);
    expect(rest).toEqual({});
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => [c.check, c.result])).toEqual([["focused", "fail"], ["docs", "fail"], ["tests", "fail"]]);
    expect((verdict as Verdict).checks.find((c) => c.check === "focused")?.evidence).toEqual(["src/flag.ts"]);
    expect((verdict as Verdict).checks.find((c) => c.check === "tests")?.evidence).toEqual(["src/flag.ts"]);
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => c.output)).toEqual([
      { kind: "score", score: expect.closeTo(20), passAt: 60, items: ["src/flag.ts"] },
      { kind: "score", score: expect.closeTo(10), passAt: 70, items: ["src/flag.ts"] },
      { kind: "score", score: expect.closeTo(10), passAt: 70, items: ["src/flag.ts"] },
    ]);
  });

  test("a file list past the tool-result cap still shows the judge its docs and test changes", async () => {
    const sources = Array.from({ length: 150 }, (_, index) => ({ ...FLAG, filename: `src/modules/feature-${index}/index.ts` }));
    const files = [...sources, { ...FLAG, filename: "docs/flag.md" }, { ...FLAG, filename: "src/flag.test.ts" }];
    expect(JSON.stringify(files).length).toBeGreaterThan(10_000);
    const pack = emptyPack(REPO);
    const { judged, verdict } = await triage({ ...pack, checks: { docs: { enabled: true }, tests: { enabled: true } } }, { files });
    expect(judged.flatMap((call) => call.questions)).toEqual([]);
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => [c.check, c.result])).toEqual([["docs", "pass"], ["tests", "pass"]]);
    expect((verdict as Verdict).checks.filter((c) => c.kind === "model").map((c) => c.output)).toEqual([
      { kind: "met", items: ["docs/flag.md"] },
      { kind: "met", items: ["src/flag.test.ts"] },
    ]);
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
    expect(unmigrated.path).toEqual(RULES_PATH);
    expect((unmigrated.verdict as Verdict).checks.find((c) => c.check === "custom-1")).toMatchObject({ result: "pass", reason: "does not apply", output: { kind: "not-applicable" } });
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

  test("an automated repository runs an automatic Do once per head", async () => {
    const github = fakeGithub();
    const pack = { ...emptyPack(REPO), actions: [HELLO, AUTO_HELLO] };
    const first = await triage(pack, { github });
    const effectId = ((first.verdict as Verdict).actions.find((a) => a.id === "auto-hello") as SuggestedDo).effectId;
    expect(first.dos).toEqual([{ effectId, status: "done" }]);
    const again = await triage(pack, { github });
    expect(again.dos).toEqual([{ effectId, status: "satisfied" }]);
    expect(github.comments.filter((c) => c.body.includes("corbits-do:"))).toEqual([expect.objectContaining({ body: `${doMarker(effectId)}\nhi` })]);
  });

  /** GitHub with CI green on head abc, for a pack that approves on every check. */
  function approving() {
    const github = fakeGithub();
    github.pr.ci = "success";
    return { github, pack: { ...emptyPack(REPO), checks: { conflicts: { enabled: true } }, actions: [APPROVE] } };
  }

  function appReads(github: ReturnType<typeof fakeGithub>): number {
    return github.requests.filter((r) => r.path === "/app").length;
  }

  test("every check passing with CI green approves the head once, pinned to it, asking for the App once", async () => {
    const { github, pack } = approving();
    const first = await triage(pack, { github });
    const effectId = ((first.verdict as Verdict).actions[0] as SuggestedDo).effectId;
    expect(first.dos).toEqual([{ effectId, status: "done" }]);
    expect(appReads(github)).toBe(1);
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

  test("passing the action's checks does not approve a pull request not ready to merge", async () => {
    const { github, pack } = approving();
    const forbidden = { ...pack, checks: { ...pack.checks, paths: { enabled: true, forbiddenGlobs: ["src/**"] } }, actions: [{ ...APPROVE, checks: ["conflicts" as const] }] };
    const { dos, verdict } = await triage(forbidden, { github });
    expect((verdict as Verdict).merge.verdict).toBe("not-recommended");
    expect((verdict as Verdict).actions).toEqual([expect.objectContaining({ kind: "approve", skipped: true, reason: "The pull request is not ready to merge." })]);
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
    return { github, pack: { ...emptyPack(REPO), checks: { ci: { enabled: true } }, actions: [REQUEST_CHANGES] } };
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
    await triage({ ...pack, checks: { conflicts: { enabled: true } } }, { github });
    expect(github.reviews).toEqual([expect.objectContaining({ id: 7, state: "APPROVED" })]);
    expect(github.requests.filter((r) => r.method === "PUT")).toEqual([]);
  });

  test("a pack without an approve Do never asks for the App", async () => {
    const github = fakeGithub();
    github.pr.draft = true;
    await triage({ ...emptyPack(REPO), checks: { conflicts: { enabled: true } } }, { github });
    expect(appReads(github)).toBe(0);
  });

  test("a human-approved repository runs no Do", async () => {
    const github = fakeGithub();
    const { dos } = await triage({ ...emptyPack(REPO), actions: [AUTO_HELLO] }, { github, cleanupMode: "human-approved" });
    expect(dos).toEqual([]);
    expect(github.comments).toEqual([]);
  });

  test("a Do GitHub refuses is reported failed with its error and stays suggested on the verdict", async () => {
    const { dos, verdict } = await triage({ ...emptyPack(REPO), actions: [AUTO_HELLO] }, { failComments: true });
    const effectId = ((verdict as Verdict).actions[0] as SuggestedDo).effectId;
    expect((verdict as Verdict).actions).toEqual([expect.objectContaining({ id: "auto-hello", effectId, automatic: true })]);
    expect(dos).toEqual([{ effectId, status: "failed", error: `github POST /repos/${REPO}/issues/8/comments -> 500` }]);
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
