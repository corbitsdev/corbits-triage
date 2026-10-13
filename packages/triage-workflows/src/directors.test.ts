import { describe, expect, test } from "bun:test";
import { listPrFilesPage } from "@corbits/github-reads";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState, ToolCall } from "@intx/types/runtime";
import { MAX_DOS_PER_RUN, triageDirectorFactory, type DoResult } from "./directors.js";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import { TRIAGE_LABELS } from "@corbits/rule-packs";
import { NEEDS_SETUP_REASON } from "./logic/checks.js";
import { MAX_SYSTEM_ONE_QUESTIONS, MAX_SYSTEM_ONE_STATE_BYTES } from "./logic/quality.js";
import { NEEDS_JUDGE_REASON, type Verdict } from "./logic/render.js";
import { evaluate, parts, rules } from "./actions/index.js";
import type { RulesOutput } from "./actions/rules.js";
import type { EffectContext } from "@intx/workflow";

const ctx = {} as EffectContext;
const signal = new AbortController().signal;

type SystemOneRequest = { providerOptions: { systemOne: { state: Record<string, any>; questions: Array<{ id: string; instructions: string }> } } };

/** Runs one judge step per rules chunk, as the workflow's map does; `respond` answers a call's questions as text or fails it. */
async function judgeChunks(ruled: RulesOutput, respond: (questions: Array<{ id: string }>, call: number) => string | { error: string }) {
  const requests: SystemOneRequest[] = [];
  const output: Array<{ reply: string }> = [];
  for (const chunk of ruled.chunks) {
    let reply = "";
    const caps = {
      infer(request: SystemOneRequest) { requests.push(request); return { type: "infer" }; },
      reply(content: string) { reply = content; return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory({ role: "judge" }, {} as never, { systemPrompt: "" } as never);
    await director.decide({ type: "message.received", message: { content: JSON.stringify(chunk) } } as ReactorInboundEvent, {} as ReactorState, caps);
    const response = respond(requests.at(-1)!.providerOptions.systemOne.questions, requests.length - 1);
    const event = typeof response === "string"
      ? { type: "inference.done", turn: { content: [{ type: "text", text: response }] } }
      : { type: "inference.error", error: { message: response.error } };
    await director.decide(event as ReactorInboundEvent, {} as ReactorState, caps);
    output.push({ reply });
  }
  return { requests, judged: { ...ruled, judge: { output } } };
}

describe("facts director policy", () => {
  test("skips disabled draft findings from the run payload", async () => {
    const replies: string[] = [];
    const caps = {
      executeTools(calls: ToolCall[]) { return { type: "execute_tools", calls }; },
      reply(content: string) { replies.push(content); return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory({ role: "facts" }, {} as never, { systemPrompt: "" } as never);
    function decide(event: ReactorInboundEvent) {
      return director.decide(event, {} as ReactorState, caps);
    }
    await decide({
      type: "message.received",
      message: {
        content: JSON.stringify({
          kind: "pr",
          repo: "acme/widgets",
          prNumber: 8,
          policy: { enabled: true, checks: { draft: false } },
          checkPack: emptyPack("acme/widgets"),
        }),
      },
    } as ReactorInboundEvent);
    await decide({
      type: "tool.done",
      result: { callId: "github_list_open_prs", content: { prs: [{ number: 8, title: "Fix" }] } },
    } as ReactorInboundEvent);
    await decide({
      type: "tool.done",
      result: {
        callId: "pr:8",
        content: { title: "Fix", author: "octocat", sha: "abc", state: "open", draft: true, mergeable: true, requestedReviewers: 1 },
      },
    } as ReactorInboundEvent);
    await decide({
      type: "tool.done",
      result: { callId: "reviews:8", content: { reviews: [{ reviewer: "a", state: "APPROVED" }] } },
    } as ReactorInboundEvent);
    await decide({
      type: "tool.done",
      result: { callId: "comments:8", content: { comments: [] } },
    } as ReactorInboundEvent);
    await decide({
      type: "tool.done",
      result: { callId: "commits:8", content: { commits: [] } },
    } as ReactorInboundEvent);
    await decide({
      type: "tool.done",
      result: {
        callId: "files:8:0",
        content: {
          files: [
            {
              path: "src/current.ts",
              previousPath: "src/previous.ts",
              status: "renamed",
              additions: 3,
              deletions: 2,
              patch: "@@ -1 +1 @@",
            },
            {
              filename: "legacy.ts",
              previous_filename: "old-legacy.ts",
              status: 7,
              additions: "many",
              deletions: 4,
              patch: null,
            },
            null,
            { path: "", filename: 7 },
          ],
        },
      },
    } as ReactorInboundEvent);
    await decide({
      type: "tool.done",
      result: { callId: "checks:8", content: { checks: [] } },
    } as ReactorInboundEvent);
    const { items } = await rules({ reply: replies[0] }, ctx, signal);
    expect(items[0]!.det.findings.map((finding) => finding.check)).not.toContain("draft");
    expect(items[0]!.facts.paths).toEqual(["src/current.ts", "legacy.ts"]);
    expect(items[0]!.facts.files).toEqual([
      {
        path: "src/current.ts",
        previousPath: "src/previous.ts",
        status: "renamed",
        additions: 3,
        deletions: 2,
        patch: "@@ -1 +1 @@",
      },
      { path: "legacy.ts", previousPath: "old-legacy.ts", deletions: 4 },
    ]);
  });

  test("a backlog skips drafts while the repository skips them", async () => {
    async function fetched(triageDrafts: boolean): Promise<string[]> {
      const calls: ToolCall[][] = [];
      const caps = {
        executeTools(next: ToolCall[]) { calls.push(next); return { type: "execute_tools", calls: next }; },
        reply(content: string) { return { type: "reply", content }; },
      } as unknown as ReactorCapabilities;
      const director = triageDirectorFactory({ role: "facts" }, {} as never, { systemPrompt: "" } as never);
      const policy = { enabled: true, triageDrafts };
      const start = { kind: "backlog", repo: "acme/widgets", policy, checkPack: emptyPack("acme/widgets") };
      await director.decide({ type: "message.received", message: { content: JSON.stringify(start) } } as ReactorInboundEvent, {} as ReactorState, caps);
      const listed = { prs: [{ number: 7, title: "WIP", draft: true }, { number: 8, title: "Fix", draft: false }] };
      const done = { type: "tool.done", result: { callId: "github_list_open_prs", content: listed } };
      await director.decide(done as ReactorInboundEvent, {} as ReactorState, caps);
      return (calls[1] ?? []).map((call) => call.id);
    }
    expect(await fetched(false)).toEqual(["pr:8", "reviews:8", "comments:8", "commits:8", "files:8:0"]);
    expect((await fetched(true)).filter((id) => id.startsWith("pr:"))).toEqual(["pr:7", "pr:8"]);
  });

  test("a disabled repository replies an error item without fetching", async () => {
    const calls: ToolCall[][] = [];
    const replies: string[] = [];
    const caps = {
      executeTools(next: ToolCall[]) { calls.push(next); return { type: "execute_tools", calls: next }; },
      reply(content: string) { replies.push(content); return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory({ role: "facts" }, {} as never, { systemPrompt: "" } as never);
    await director.decide(
      {
        type: "message.received",
        message: {
          content: JSON.stringify({
            kind: "pr",
            repo: "acme/widgets",
            prNumber: 8,
            policy: { enabled: false },
          }),
        },
      } as ReactorInboundEvent,
      {} as ReactorState,
      caps,
    );
    expect(calls).toEqual([]);
    expect(JSON.parse(replies[0] ?? "{}")).toEqual({ items: [{ error: "Triage is disabled for this repository." }], batch: false });
  });

  test("missing check pack skips classify without fetching", async () => {
    const calls: ToolCall[][] = [];
    const replies: string[] = [];
    const caps = {
      executeTools(next: ToolCall[]) { calls.push(next); return { type: "execute_tools", calls: next }; },
      reply(content: string) { replies.push(content); return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory({ role: "facts" }, {} as never, { systemPrompt: "" } as never);
    await director.decide(
      {
        type: "message.received",
        message: {
          content: JSON.stringify({
            kind: "pr",
            repo: "acme/widgets",
            prNumber: 8,
            policy: { enabled: true },
          }),
        },
      } as ReactorInboundEvent,
      {} as ReactorState,
      caps,
    );
    expect(calls).toEqual([]);
    expect(JSON.parse(replies[0] ?? "{}")).toEqual({ items: [{ error: NEEDS_SETUP_REASON }], batch: false });
  });

  async function factsThrough(filesContent: string) {
    const pending: ToolCall[] = [];
    let reply = "";
    const caps = {
      executeTools(next: ToolCall[]) { pending.push(...next); return { type: "execute_tools", calls: next }; },
      reply(content: string) { reply = content; return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory({ role: "facts" }, {} as never, { systemPrompt: "" } as never);
    const start = { kind: "pr", repo: "acme/widgets", prNumber: 8, policy: { enabled: true }, checkPack: recommendedPack("acme/widgets") };
    await director.decide({ type: "message.received", message: { content: JSON.stringify(start) } } as ReactorInboundEvent, {} as ReactorState, caps);
    const results: Record<string, unknown> = {
      github_list_open_prs: { prs: [{ number: 8, title: "Fix #3" }] },
      "docs:0": { docs: [], rules: [], ref: "tree" },
      "pr:8": { title: "Fix #3", author: "octocat", sha: "abc", state: "open", draft: false, mergeable: true, requestedReviewers: 1 },
      "reviews:8": { reviews: [] },
      "commits:8": { commits: [] },
      "checks:8": { checks: [] },
    };
    while (pending.length) {
      const next = pending.shift()!;
      const content = next.name === "github_list_pr_files" ? filesContent : results[next.id];
      await director.decide({ type: "tool.done", result: { callId: next.id, content } } as ReactorInboundEvent, {} as ReactorState, caps);
    }
    return rules({ reply }, ctx, signal);
  }

  test.each([
    ["cut off", `{"files":[{"path":"src/a.ts","status":"modified","patch":"@@ -1 +1 @@\\n+a"}\n[Tool output truncated: omitted 5000 chars. Full output available at tool-output:///files:8:0 -- use read_file with that URI to see the rest.]`],
    ["unparsable", "not json"],
  ])("a %s file list degrades the item instead of reading as no files", async (_name, content) => {
    const ruled = await factsThrough(content);
    expect(ruled.items[0]!.error).toMatch(/^github_list_pr_files result (was truncated|is unreadable) for #8$/);
    const verdict = await evaluate(ruled, ctx, signal) as Verdict;
    expect(verdict).toMatchObject({ degraded: "error", mirror: false });
  });
});

describe("judge on a blocked pull request", () => {
  function director(role: "facts" | "judge", caps: Partial<Record<"executeTools" | "reply" | "infer", unknown>>) {
    const d = triageDirectorFactory({ role }, {} as never, { systemPrompt: "" } as never);
    return (event: unknown) => d.decide(event as ReactorInboundEvent, {} as ReactorState, caps as unknown as ReactorCapabilities);
  }

  async function facts(checkRuns: unknown[], mergeable: boolean | null, draft = false, setup: Record<string, unknown> = {}, files: unknown[] = []): Promise<string> {
    let reply = "";
    const called = new Set<string>();
    const decide = director("facts", {
      executeTools(calls: ToolCall[]) { for (const { id } of calls) called.add(id); return { type: "execute_tools", calls }; },
      reply(content: string) { reply = content; return { type: "reply", content }; },
    });
    await decide({ type: "message.received", message: { content: JSON.stringify({ kind: "pr", repo: "acme/widgets", prNumber: 8, policy: { enabled: true }, checkPack: recommendedPack("acme/widgets"), ...setup }) } });
    const results: Record<string, unknown> = {
      github_list_open_prs: { prs: [{ number: 8, title: "Fix #3" }] },
      "docs:0": { docs: [], rules: [], ref: "tree" },
      "pr:8": { title: "Fix #3", author: "octocat", sha: "abc", state: "open", draft, mergeable, requestedReviewers: 1 },
      "reviews:8": { reviews: [] },
      "commits:8": { commits: [] },
      "files:8:0": { files },
      "comments:8": { comments: [] },
      "checks:8": { checks: checkRuns },
    };
    for (const [callId, content] of Object.entries(results)) if (called.has(callId)) await decide({ type: "tool.done", result: { callId, content } });
    return reply;
  }

  /** No file needs docs; focused is more than one thing when it is failing; every other question is a noul pass or fail. */
  function answer(id: string, failing: string[]) {
    if (/^docs-file-/.test(id)) return { id, type: "noul", noul: 0.1 };
    if (id !== "focused") return { id, type: "noul", noul: failing.includes(id) ? 0.1 : 0.9 };
    const choice = failing.includes("focused") ? "more_than_one_thing" : "one_thing";
    const probabilities = { one_thing: 0.2, more_than_one_thing: 0.2, cant_tell: 0.1, [choice]: 0.7 };
    return { id, type: "choice", choice, probabilities, confidence: 0.9 };
  }

  /** Runs rules, the judge only when the gate would, and evaluate, as the workflow does. */
  async function judgeAndEvaluate(factsReply: string, judgeError?: string, failing = ["focused"]): Promise<{ asked: string[]; verdict: Verdict }> {
    const ruled = await rules({ reply: factsReply }, ctx, signal);
    if (!ruled.needsJudgment) return { asked: [], verdict: await evaluate(ruled, ctx, signal) as Verdict };
    const { requests, judged } = await judgeChunks(ruled, (questions) => (judgeError !== undefined
      ? { error: judgeError }
      : questions.map(({ id }) => JSON.stringify(answer(id, failing))).join("")));
    const asked = requests.flatMap((request) => request.providerOptions.systemOne.questions.map((q) => q.id));
    return { asked, verdict: await evaluate(judged, ctx, signal) as Verdict };
  }

  test("reads a patch too long for one page across pages and judges it whole", async () => {
    const patch = Array.from({ length: 6 }, (_, index) => `@@ -${index * 10 + 1} +${index * 10 + 1} @@\n+const part${index} = "${"x".repeat(2_500)}";`).join("\n");
    async function gh() {
      return Response.json([{ filename: "src/big.ts", status: "modified", additions: 6, deletions: 0, patch }]);
    }
    const pending: ToolCall[] = [];
    let reply = "";
    const decide = director("facts", {
      executeTools(calls: ToolCall[]) { pending.push(...calls); return { type: "execute_tools", calls }; },
      reply(content: string) { reply = content; return { type: "reply", content }; },
    });
    await decide({ type: "message.received", message: { content: JSON.stringify({ kind: "pr", repo: "acme/widgets", prNumber: 8, policy: { enabled: true }, checkPack: recommendedPack("acme/widgets") }) } });
    const results: Record<string, unknown> = {
      github_list_open_prs: { prs: [{ number: 8, title: "Fix #3" }] },
      "docs:0": { docs: [], rules: [], ref: "tree" },
      "pr:8": { title: "Fix #3", author: "octocat", sha: "abc", state: "open", draft: false, mergeable: true, requestedReviewers: 1 },
      "reviews:8": { reviews: [] },
      "commits:8": { commits: [] },
      "checks:8": { checks: [] },
    };
    let pages = 0;
    async function filesPage(args: ToolCall["arguments"]) {
      pages++;
      return listPrFilesPage(gh, "acme/widgets", 8, args as Parameters<typeof listPrFilesPage>[3]);
    }
    while (pending.length) {
      const next = pending.shift()!;
      const content = next.name === "github_list_pr_files" ? await filesPage(next.arguments) : results[next.id];
      await decide({ type: "tool.done", result: { callId: next.id, content } });
    }
    const { verdict } = await judgeAndEvaluate(reply, undefined, []);
    expect(pages).toBeGreaterThan(1);
    expect(verdict.checks.find((check) => check.check === "focused")).toMatchObject({ result: "pass" });
    expect(verdict.checks.find((check) => check.check === "focused")?.output).toEqual({ kind: "score", score: 70, passAt: 60, items: [] });
  });

  test("code GitHub sent no patch for leaves focused unconfirmed, a generated or binary file does not", async () => {
    const read = { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+const a = 1;" };
    const lockfile = { path: "bun.lock", status: "modified", additions: 900, deletions: 0 };
    const binary = { path: "logo.png", status: "added", additions: 0, deletions: 0 };
    const code = { path: "src/b.ts", status: "modified", additions: 900, deletions: 0 };
    async function focused(files: unknown[]) {
      const { verdict } = await judgeAndEvaluate(await facts([], true, false, {}, files), undefined, []);
      return verdict.checks.find((check) => check.check === "focused");
    }
    expect((await focused([read, lockfile, binary]))?.output).toEqual({ kind: "score", score: 70, passAt: 60, items: [] });
    expect(await focused([read, lockfile, binary, code])).toMatchObject({ result: "unconfirmed", output: { kind: "could-not-check", items: ["src/b.ts"] } });
  });

  test("a coalesced run wakes an action on any event it carries, not only the latest", async () => {
    const checkPack = {
      ...emptyPack("acme/widgets"),
      checks: { ci: { enabled: true } },
      actions: [{ id: "greet", when: ["opened"], checks: ["ci"], branches: { yes: [{ kind: "comment", automatic: false, target: { body: "Welcome" } }] } }],
    };
    const latest = { checkPack, event: "check_run", action: "completed" };
    async function actionIds(setup: Record<string, unknown>): Promise<string[]> {
      const { verdict } = await judgeAndEvaluate(await facts([{ name: "build", status: "completed", conclusion: "success" }], true, false, setup));
      return verdict.actions.map((action) => action.id);
    }
    expect(await actionIds({ ...latest, events: ["opened", "checks"] })).toEqual(["greet"]);
    expect(await actionIds(latest)).toEqual([]);
  });

  const code = [{ filename: "src/flag.ts", patch: "@@ -0,0 +1 @@\n+export const flag = true;" }];

  test("a CI-blocked pull request records the model's answers but stays driven by CI", async () => {
    const { asked, verdict } = await judgeAndEvaluate(await facts([{ name: "build", status: "completed", conclusion: "failure" }], true, false, {}, code), undefined, []);
    expect(asked).toEqual(["docs-file-001", "focused"]);
    expect(verdict).toMatchObject({ state: "blocked", reason: "required checks are failing", actor: "author", nextAction: "Fix failing CI: build" });
    expect(verdict.checks.filter((c) => c.kind === "model")).toEqual([
      { check: "focused", kind: "model", result: "pass", reason: "makes one focused change", evidence: [], output: { kind: "score", score: 70, passAt: 60, items: [] } },
      { check: "docs", kind: "model", result: "pass", reason: "documentation is up to date", evidence: [], output: { kind: "score", score: 90, passAt: 70, items: ["src/flag.ts"] } },
    ]);
  });

  test("a judge outage on a blocked pull request leaves the verdict settled", async () => {
    const { verdict } = await judgeAndEvaluate(await facts([{ name: "build", status: "completed", conclusion: "failure" }], true, false, {}, code), "upstream 503");
    expect(verdict).toMatchObject({ state: "blocked", degraded: null, mirror: true });
    expect(verdict.checks.some((c) => c.kind === "machine" && c.result === "unconfirmed")).toBe(false);
    expect(verdict.checks.filter((c) => c.kind === "model").map((c) => c.reason)).toEqual(["decision model unavailable", "decision model unavailable"]);
  });

  test("a clean draft awaits review with an informational draft check, asks nothing of the author and is red", async () => {
    const feedback = "No changes needed from you. A maintainer will review this pull request.";
    const { asked, verdict } = await judgeAndEvaluate(await facts([], true, true), undefined, []);
    expect(asked).toEqual([]);
    expect(verdict).toMatchObject({ state: "awaiting-review", degraded: null, mirror: true, humanGated: false, feedback, actor: "maintainer", nextAction: "Review once marked ready" });
    expect(verdict.merge.reasons).toEqual(["Failed: pull request is a draft"]);
    expect(verdict.checks.find((c) => c.check === "draft")).toEqual({ check: "draft", kind: "machine", result: "fail", reason: "pull request is a draft", evidence: [], output: { kind: "values", values: { isDraft: true } } });
    expect(verdict.request).toEqual({ repo: "acme/widgets", number: 8, labels: verdict.labels, owned: TRIAGE_LABELS, comment: feedback });
  });

  test("a degraded verdict suggests no actions", async () => {
    const checkPack = { ...recommendedPack("acme/widgets"), actions: [{ id: "hello", when: "every", checks: [], branches: { always: [{ kind: "comment", automatic: false, target: { body: "hi" } }] } }] };
    const { verdict } = await judgeAndEvaluate(await facts([], true, false, { checkPack }, code), "upstream 503");
    expect(verdict.degraded).toBe("inference-outage");
    expect(verdict.actions).toEqual([]);
  });

  test("suggests a pack action matched on a model check, resolved through the policy's roles", async () => {
    const checkPack = {
      ...recommendedPack("acme/widgets"),
      actions: [{ id: "ask-leads", when: "every", checks: ["focused"], branches: { no: [{ kind: "request-review", automatic: true, target: { to: "role", role: "leads" } }] } }],
    };
    const policy = { enabled: true, roles: { leads: { users: ["dave"] } } };
    const files = [{ filename: "src/flag.ts", patch: "@@ -0,0 +1 @@\n+export const flag = true;" }];
    const { verdict } = await judgeAndEvaluate(await facts([], true, false, { policy, checkPack }, files));
    expect(verdict.actions).toEqual([
      { id: "ask-leads", branch: "no", index: 0, effectId: expect.any(String), kind: "request-review", automatic: true, target: { users: ["dave"], teams: [] }, reason: "Focused change failed." },
    ]);
  });

  test("a gapped custom check id matches the action on that check, not its neighbour", async () => {
    const checkPack = {
      ...recommendedPack("acme/widgets"),
      custom: [
        { id: "custom-2", name: "No secrets", group: "pull-request", instruction: "No secrets are committed." },
        { id: "custom-3", name: "Changelog", group: "pull-request", instruction: "The changelog is updated." },
      ],
      actions: [
        { id: "on-2", when: "every", checks: ["custom-2"], branches: { no: [{ kind: "comment", automatic: false, target: { body: "secrets" } }] } },
        { id: "on-3", when: "every", checks: ["custom-3"], branches: { no: [{ kind: "comment", automatic: false, target: { body: "changelog" } }] } },
      ],
    };
    const { verdict } = await judgeAndEvaluate(await facts([], true, false, { checkPack }), undefined, ["custom-3"]);
    expect(verdict.actions).toEqual([
      { id: "on-3", branch: "no", index: 0, effectId: expect.any(String), kind: "comment", automatic: false, target: { body: "changelog" }, reason: "Changelog failed." },
    ]);
  });

  test("stale-unknown facts skip the model", async () => {
    const { asked, verdict } = await judgeAndEvaluate(await facts([], null, false, {}, code));
    expect(asked).toEqual([]);
    expect(verdict.state).toBe("stale-unknown");
    expect(verdict.checks.filter((c) => c.kind === "model").map((c) => c.reason)).toEqual(["not asked", "not asked"]);
  });
});

describe("focused judge input", () => {
  function prFacts(files: Array<Record<string, unknown>>) {
    return {
      repo: "acme/widgets",
      number: 8,
      title: "Refactor",
      author: "octocat",
      tier: "external",
      headSha: "abc",
      state: "open",
      draft: false,
      mergeable: true,
      checks: "success",
      approvals: 0,
      files,
    };
  }

  const pack = { ...emptyPack("acme/widgets"), checks: { focused: { enabled: true } } };
  /** A focused answer with `serves` the probability its slice serves the pull request's purpose; undefined for any other question. */
  function focusedAnswer(id: string, serves: number, separate: number) {
    if (id === "focused") return { id, type: "choice", choice: "one_thing", probabilities: { one_thing: serves, more_than_one_thing: separate, cant_tell: 1 - serves - separate }, confidence: 0.9 };
    if (!/^focused-slice-\d+$/.test(id)) return undefined;
    const choice = serves >= separate ? "serves_purpose" : "separate_change";
    return { id, type: "choice", choice, probabilities: { serves_purpose: serves, separate_change: separate, cant_tell: 1 - serves - separate }, confidence: 0.9 };
  }

  function ruledFor(files: Array<Record<string, unknown>>) {
    return rules({ items: [{ facts: prFacts(files), pack }], batch: false }, ctx, signal);
  }

  function primary(questions: Array<{ id: string }>) {
    return questions.map(({ id }) => JSON.stringify(focusedAnswer(id, 0.9, 0.05) ?? { id, type: "noul", noul: 0.1 })).join("");
  }

  test("asks one choice about the whole pull request, and a question per file only once it fails", async () => {
    const patch = "@@ -1 +1 @@\n-const item = { name: \"Old\" };\n+const item = { name: \"New\" };";
    const ruled = await ruledFor([{ path: "src/a.ts", previousPath: "src/old-a.ts", status: "renamed", patch }]);
    const first = await judgeChunks(ruled, () => JSON.stringify({ id: "focused", type: "choice", choice: "more_than_one_thing", probabilities: { one_thing: 0.1, more_than_one_thing: 0.85, cant_tell: 0.05 }, confidence: 0.9 }));
    expect(first.requests).toHaveLength(1);
    const systemOne = first.requests[0]!.providerOptions.systemOne;
    expect(systemOne.questions.map((question: Record<string, unknown>) => [question.id, Object.keys(question.criteria as Record<string, unknown>)])).toEqual([
      ["focused", ["one_thing", "more_than_one_thing", "cant_tell"]],
    ]);
    expect(systemOne.state.pullRequest.files).toEqual([{ path: "src/a.ts", status: "renamed", hunks: [patch] }]);
    const passing = await judgeChunks(ruled, primary);
    expect((await parts(passing.judged, ctx, signal)).chunks).toEqual([]);

    const { chunks } = await parts(first.judged, ctx, signal);
    const second = await judgeChunks({ ...ruled, chunks }, (questions) => questions.map(({ id }) => JSON.stringify({ id, type: "noul", noul: 0.9 })).join(""));
    expect(second.requests.map((request) => request.providerOptions.systemOne.questions.map((question) => [question.id, question.instructions]))).toEqual([
      [["focused-file-001", expect.stringContaining("`pullRequest.files[0]`")]],
    ]);
    const verdict = await evaluate({ ...first.judged, judgeParts: second.judged.judge }, ctx, signal) as Verdict;
    expect(verdict.checks.find((check) => check.check === "focused")).toMatchObject({ result: "fail", evidence: ["src/a.ts"] });
  });

  function largeFiles(prefix: string, count: number) {
    return Array.from({ length: count }, (_, index) => ({
      path: `src/${prefix}${index}.ts`,
      patch: [`@@ -1 +1,40 @@`, `+export const ${prefix}${index} = 1;`, ...Array.from({ length: 40 }, (_, line) => `+// ${"evidence ".repeat(12)}${line}`)].join("\n"),
    }));
  }

  function withinBudget(request: SystemOneRequest): boolean {
    const { state, questions } = request.providerOptions.systemOne;
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    return bytes(state) <= MAX_SYSTEM_ONE_STATE_BYTES && questions.length <= MAX_SYSTEM_ONE_QUESTIONS;
  }

  test("a pull request over the request budget is judged in slices that read every file: it passes when each serves its purpose and fails when one is separate", async () => {
    const files = largeFiles("large", 24);
    expect(files.reduce((total, file) => total + file.patch.length, 0)).toBeGreaterThan(MAX_SYSTEM_ONE_STATE_BYTES);
    const ruled = await ruledFor(files);
    const { requests, judged } = await judgeChunks(ruled, primary);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.every(withinBudget)).toBe(true);
    const slices = requests.map((request) => request.providerOptions.systemOne.state.pullRequest.files.map((file: { path: string }) => file.path));
    expect(slices.flat()).toEqual(files.map((file) => file.path));
    const verdict = await evaluate(judged, ctx, signal) as Verdict;
    expect(verdict.degraded).toBeNull();
    expect(verdict.checks.filter((c) => c.kind === "model")).toEqual([{ check: "focused", kind: "model", result: "pass", reason: "makes one focused change", evidence: [], output: { kind: "score", score: 90, passAt: 60, items: [] } }]);

    const split = await judgeChunks(ruled, (questions, call) => questions.map(({ id }) => JSON.stringify(call === 1 ? focusedAnswer(id, 0.1, 0.8) : focusedAnswer(id, 0.9, 0.05))).join(""));
    const { chunks } = await parts(split.judged, ctx, signal);
    const named = await judgeChunks({ ...ruled, chunks }, (questions) => questions.map(({ id }) => JSON.stringify({ id, type: "noul", noul: 0.9 })).join(""));
    expect(named.requests.flatMap((request) => request.providerOptions.systemOne.state.pullRequest.files.map((file: { path: string }) => file.path))).toEqual(slices[1]);
    const failed = await evaluate({ ...split.judged, judgeParts: named.judged.judge }, ctx, signal) as Verdict;
    expect(failed.checks.find((check) => check.check === "focused")).toMatchObject({ result: "fail", evidence: slices[1]!.slice(0, 3) });
  });

  test("a batch asks per pull request, and a failed chunk degrades only its own pull request", async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({ facts: { ...prFacts(largeFiles(`batch${index}x`, 24)), number: index + 1 }, pack }));
    const ruled = await rules({ items, batch: true }, ctx, signal);
    expect(new Set(ruled.chunks.map((chunk) => chunk.item))).toEqual(new Set([0, 1, 2]));
    expect(ruled.chunks.length).toBeGreaterThanOrEqual(6);
    const failed = ruled.chunks.findIndex((chunk) => chunk.item === 0);
    const { requests, judged } = await judgeChunks(ruled, (questions, call) => (call === failed ? { error: "upstream 503" } : primary(questions)));
    expect(requests).toHaveLength(ruled.chunks.length);
    expect(requests.every(withinBudget)).toBe(true);

    const { items: verdicts } = await evaluate(judged, ctx, signal) as { items: Verdict[] };
    expect(verdicts.map((verdict) => verdict.degraded)).toEqual(["inference-outage", null, null]);
    expect(verdicts[0]!.reason).toBe("decision model unavailable: upstream 503");
    expect(verdicts[0]!.checks.filter((c) => c.kind === "model")).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: "decision model unavailable", evidence: [], output: { kind: "could-not-check", reason: "decision model unavailable" } }]);
  });

  test("an evaluation whose metadata alone is over the budget skips the judge and leaves focused and docs to a maintainer without accusation", async () => {
    const files = Array.from({ length: 200 }, (_, index) => ({ path: `src/${"nested/".repeat(80)}${index}.ts` }));
    const withDocs = { ...pack, checks: { ...pack.checks, docs: { enabled: true } } };
    const ruled = await rules({ items: [{ facts: { ...prFacts(files), paths: files.map((file) => file.path) }, pack: withDocs }], batch: false }, ctx, signal);
    expect(ruled.needsJudgment).toBe(false);
    const tooLarge = "pull request too large for the decision model (112 KB)";
    expect(ruled.items[0]).toMatchObject({ judgeError: tooLarge, judgeLimitExceeded: true });

    const verdict = await evaluate(ruled, ctx, signal) as Verdict;
    expect(verdict).toMatchObject({ state: "awaiting-review", mirror: true, humanGated: false, degraded: null, feedback: "Not yet confirmed, a maintainer will check:\n- makes one focused change\n- documentation is up to date", reason: tooLarge });
    expect(verdict.checks.filter((c) => c.kind === "model")).toEqual([
      { check: "focused", kind: "model", result: "unconfirmed", reason: tooLarge, evidence: [], output: { kind: "could-not-check", reason: tooLarge } },
      { check: "docs", kind: "model", result: "unconfirmed", reason: tooLarge, evidence: [], output: { kind: "could-not-check", reason: tooLarge } },
    ]);
  });
});

describe("mirror director cleanup mode", () => {
  const request = { repo: "acme/widgets", number: 8, labels: ["ready-monitoring"], owned: TRIAGE_LABELS, comment: "Looks good" };
  const verdict = {
    repo: "acme/widgets",
    number: 8,
    state: "ready-monitoring",
    headSha: "abc",
    merge: { verdict: "ready" },
    mirror: true,
    request,
    confidence: 0.9,
    humanGated: false,
  };

  async function mirrorCalls(payload: Record<string, unknown>): Promise<ToolCall[][]> {
    const calls: ToolCall[][] = [];
    const caps = {
      executeTools(next: ToolCall[]) { calls.push(next); return { type: "execute_tools", calls: next }; },
      reply(content: string) { return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory({ role: "mirror" }, {} as never, { systemPrompt: "" } as never);
    await director.decide(
      { type: "message.received", message: { content: JSON.stringify(payload) } } as ReactorInboundEvent,
      {} as ReactorState,
      caps,
    );
    return calls;
  }

  test("automated high-confidence posts with the no-ask tool", async () => {
    expect(await mirrorCalls({ ...verdict, cleanupMode: "automated" })).toEqual([[
      {
        id: "mirror:acme--widgets:8",
        name: "github_mirror_auto",
        arguments: request,
      },
    ]]);
  });

  test("human-approved never calls a tool", async () => {
    expect(await mirrorCalls({ ...verdict, cleanupMode: "human-approved" })).toEqual([]);
  });
});

describe("execute", () => {
  const REQUEST = { repo: "acme/widgets", number: 8, labels: [], owned: [], comment: "" };

  function comment(index: number) {
    return { id: "hi", branch: "always", index, kind: "comment", automatic: true, reason: "Always applies.", effectId: `e${index}`, target: { body: "hi" } };
  }

  /** Answers every Do call done, one at a time as the director asks, and returns the calls and its reply. */
  async function execute(verdict: Record<string, unknown>) {
    const calls: ToolCall[] = [];
    let reply: { dos: DoResult[] } | undefined;
    const caps = {
      executeTools(batch: ToolCall[]) { calls.push(...batch); return { type: "execute_tools", calls: batch }; },
      reply(content: string) { reply = JSON.parse(content); return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory({ role: "execute" }, {} as never, { systemPrompt: "" } as never);
    let taken = [await director.decide({ type: "message.received", message: { content: JSON.stringify(verdict) } } as ReactorInboundEvent, {} as ReactorState, caps)].flat() as Array<{ type: string; calls?: ToolCall[] }>;
    while (reply === undefined) {
      const asked = taken.flatMap((action) => action.calls ?? []);
      expect(asked).toHaveLength(1);
      const result = { callId: asked[0]!.id, content: { status: "done" } };
      taken = [await director.decide({ type: "tool.done", result } as ReactorInboundEvent, {} as ReactorState, caps)].flat() as typeof taken;
    }
    return { calls, dos: reply.dos };
  }

  const verdict = { repo: "acme/widgets", number: 8, headSha: "abc", degraded: null, state: "ready", cleanupMode: "automated", request: REQUEST, checks: [], actions: [comment(0)] };

  test("a verdict whose judge was skipped runs no Do", async () => {
    const skipped = { ...verdict, checks: [{ check: "focused", kind: "model", result: "unconfirmed", reason: NEEDS_JUDGE_REASON }] };
    expect(await execute(skipped)).toEqual({ calls: [], dos: [{ effectId: "e0", status: "skipped", error: "verdict not settled" }] });
  });

  test("Dos run one at a time, and those past the per-run cap stay pending", async () => {
    const many = { ...verdict, actions: Array.from({ length: MAX_DOS_PER_RUN + 2 }, (_, index) => comment(index)) };
    const { calls, dos } = await execute(many);
    expect(calls).toHaveLength(MAX_DOS_PER_RUN);
    expect(calls[0]!.arguments).toEqual({ request: REQUEST, step: { effectId: "e0", headSha: "abc", kind: "comment", target: { body: "hi" } } });
    expect(dos.filter((d) => d.status === "skipped").map((d) => d.effectId)).toEqual([`e${MAX_DOS_PER_RUN}`, `e${MAX_DOS_PER_RUN + 1}`]);
  });
});
