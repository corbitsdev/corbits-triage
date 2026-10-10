import { describe, expect, test } from "bun:test";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState, ToolCall } from "@intx/types/runtime";
import { triageDirectorFactory } from "./directors.js";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import { TRIAGE_LABELS } from "@corbits/rule-packs";
import { NEEDS_SETUP_REASON } from "./logic/checks.js";
import type { Verdict } from "./logic/render.js";
import { evaluate, rules } from "./actions/index.js";
import type { EffectContext } from "@intx/workflow";

const ctx = {} as EffectContext;
const signal = new AbortController().signal;

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
    expect(await fetched(false)).toEqual(["pr:8", "reviews:8", "commits:8", "files:8:0"]);
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
    const decide = director("facts", {
      executeTools(calls: ToolCall[]) { return { type: "execute_tools", calls }; },
      reply(content: string) { reply = content; return { type: "reply", content }; },
    });
    await decide({ type: "message.received", message: { content: JSON.stringify({ kind: "pr", repo: "acme/widgets", prNumber: 8, policy: { enabled: true }, checkPack: recommendedPack("acme/widgets"), ...setup }) } });
    const results: Record<string, unknown> = {
      github_list_open_prs: { prs: [{ number: 8, title: "Fix #3" }] },
      "pr:8": { title: "Fix #3", author: "octocat", sha: "abc", state: "open", draft, mergeable, requestedReviewers: 1 },
      "reviews:8": { reviews: [] },
      "commits:8": { commits: [] },
      "files:8:0": { files },
      "comments:8": { comments: [] },
      "checks:8": { checks: checkRuns },
    };
    for (const [callId, content] of Object.entries(results)) await decide({ type: "tool.done", result: { callId, content } });
    return reply;
  }

  /** A focused candidate is unrelated when focused is failing; every other question is a noul pass or fail. */
  function answer(id: string, failing: string[]) {
    if (!id.startsWith("focused-candidate-")) return { id, type: "noul", noul: failing.includes(id) ? 0.1 : 0.9 };
    const choice = failing.includes("focused") ? "unrelated" : "primary_or_supporting";
    const probabilities = { primary_or_supporting: 0.1, unrelated: 0.1, movement_or_superseded: 0.1, ambiguous: 0.1, [choice]: 0.7 };
    return { id, type: "choice", choice, probabilities, confidence: 0.9 };
  }

  /** Runs rules, the judge only when the gate would, and evaluate, as the workflow does. */
  async function judgeAndEvaluate(factsReply: string, judgeError?: string, failing = ["focused"]): Promise<{ asked: string[]; verdict: Verdict }> {
    const ruled = await rules({ reply: factsReply }, ctx, signal);
    if (!ruled.needsJudgment) return { asked: [], verdict: await evaluate(ruled, ctx, signal) as Verdict };
    let judged = "";
    const asked: string[] = [];
    const judge = director("judge", {
      infer(request: { providerOptions: { systemOne: { questions: Array<{ id: string }> } } }) {
        asked.push(...request.providerOptions.systemOne.questions.map((q) => q.id));
        return { type: "infer" };
      },
      reply(content: string) { judged = content; return { type: "reply", content }; },
    });
    await judge({ type: "message.received", message: { content: JSON.stringify(ruled) } });
    if (asked.length && judgeError !== undefined) await judge({ type: "inference.error", error: { message: judgeError } });
    else if (asked.length) {
      const text = asked.map((id) => JSON.stringify(answer(id, failing))).join("");
      await judge({ type: "inference.done", turn: { content: [{ type: "text", text }] } });
    }
    return { asked, verdict: await evaluate({ ...ruled, reply: judged }, ctx, signal) as Verdict };
  }

  test("a CI-blocked pull request records the model's answers but stays driven by CI", async () => {
    const { asked, verdict } = await judgeAndEvaluate(await facts([{ name: "build", status: "completed", conclusion: "failure" }], true));
    expect(asked).toEqual(["docs", "tests"]);
    expect(verdict).toMatchObject({ state: "blocked", reason: "required checks are failing", actor: "author", nextAction: "Fix failing CI: build" });
    expect(verdict.feedback).not.toContain("unrelated");
    expect(verdict.checks.filter((c) => c.kind === "model")).toEqual([
      { check: "focused", kind: "model", result: "unconfirmed", reason: "no change candidates", evidence: [] },
      { check: "docs", kind: "model", result: "pass", reason: "documentation is up to date", evidence: [] },
      { check: "tests", kind: "model", result: "pass", reason: "tests cover the change", evidence: [] },
    ]);
  });

  test("a judge outage on a blocked pull request leaves the verdict settled", async () => {
    const { verdict } = await judgeAndEvaluate(await facts([{ name: "build", status: "completed", conclusion: "failure" }], true), "upstream 503");
    expect(verdict).toMatchObject({ state: "blocked", degraded: null, mirror: true });
    expect(verdict.checks.some((c) => c.kind === "machine" && c.result === "unconfirmed")).toBe(false);
    expect(verdict.checks.filter((c) => c.kind === "model").map((c) => c.reason)).toEqual(["no change candidates", "decision model unavailable", "decision model unavailable"]);
  });

  test("a clean draft awaits review with an informational draft check and labels only", async () => {
    const { asked, verdict } = await judgeAndEvaluate(await facts([], true, true), undefined, []);
    expect(asked).toEqual(["docs", "tests"]);
    expect(verdict).toMatchObject({ state: "awaiting-review", degraded: null, mirror: false, humanGated: true, feedback: "", actor: "maintainer", nextAction: "Review once marked ready" });
    expect(verdict.checks.find((c) => c.check === "draft")).toEqual({ check: "draft", kind: "machine", result: "fail", reason: "pull request is a draft", evidence: [] });
    expect(verdict.request).toEqual({ repo: "acme/widgets", number: 8, labels: verdict.labels, owned: TRIAGE_LABELS, comment: "", close: false });
  });

  test("a degraded verdict suggests no actions", async () => {
    const checkPack = { ...recommendedPack("acme/widgets"), actions: [{ id: "hello", when: "every", checks: [], branches: { always: [{ kind: "comment", automatic: false, target: { body: "hi" } }] } }] };
    const { verdict } = await judgeAndEvaluate(await facts([], true, false, { checkPack }), "upstream 503");
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
    const { asked, verdict } = await judgeAndEvaluate(await facts([], null));
    expect(asked).toEqual([]);
    expect(verdict.state).toBe("stale-unknown");
    expect(verdict.checks.filter((c) => c.kind === "model").map((c) => c.reason)).toEqual(["not asked", "not asked", "not asked"]);
  });
});

describe("focused candidate judge input", () => {
  const sources = { quality: [{ id: "focused" as const, group: "pull-request" as const }], custom: [] };

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
      baseBehindBy: 0,
      checks: "success",
      requestedReviewers: 0,
      approvals: 0,
      openPrs: [],
      files,
    };
  }

  function rulesOutput(files: Array<Record<string, unknown>>) {
    const det = { state: "ready-monitoring", reason: "all configured checks pass", findings: [], checks: [], duplicateOf: null, needsJudgment: true, sources };
    return { items: [{ facts: prFacts(files), det }], batch: false, needsJudgment: true };
  }

  test("sends one typed choice per candidate with matching ID-keyed state", async () => {
    const requests: Array<Record<string, any>> = [];
    const caps = {
      infer(request: Record<string, any>) { requests.push(request); return { type: "infer" }; },
      reply(content: string) { return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory({ role: "judge" }, {} as never, { systemPrompt: "" } as never);
    await director.decide({
      type: "message.received",
      message: { content: JSON.stringify(rulesOutput([{
        path: "src/a.ts",
        previousPath: "src/old-a.ts",
        status: "renamed",
        patch: "@@ -1 +1 @@\n-const item = { name: \"Old\" };\n+const item = { name: \"New\" };",
      }])) },
    } as ReactorInboundEvent, {} as ReactorState, caps);
    expect(requests).toHaveLength(1);
    const systemOne = requests[0]?.providerOptions.systemOne;
    expect(systemOne.questions.map((question: Record<string, unknown>) => ({
      id: question.id,
      type: question.type,
      choices: Object.keys(question.criteria as Record<string, unknown>),
    }))).toEqual([
      {
        id: "focused-candidate-001",
        type: "choice",
        choices: ["primary_or_supporting", "unrelated", "movement_or_superseded", "ambiguous"],
      },
      {
        id: "focused-candidate-002",
        type: "choice",
        choices: ["primary_or_supporting", "unrelated", "movement_or_superseded", "ambiguous"],
      },
    ]);
    expect(systemOne.state.changeCandidates).toEqual({
      "focused-candidate-001": {
        path: "src/a.ts",
        previousPath: "src/old-a.ts",
        status: "renamed",
        label: "Old",
        evidence: "@@ -1 +1 @@\n-const item = { name: \"Old\" };\n+const item = { name: \"New\" };",
      },
      "focused-candidate-002": {
        path: "src/a.ts",
        previousPath: "src/old-a.ts",
        status: "renamed",
        label: "New",
        evidence: "@@ -1 +1 @@\n-const item = { name: \"Old\" };\n+const item = { name: \"New\" };",
      },
    });
  });

  test("an author's label cannot mention, link or format in the judge prompt or the comment", async () => {
    const requests: Array<Record<string, any>> = [];
    let judged = "";
    const caps = {
      infer(request: Record<string, any>) { requests.push(request); return { type: "infer" }; },
      reply(content: string) { judged = content; return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory({ role: "judge" }, {} as never, { systemPrompt: "" } as never);
    const payload = JSON.stringify({ name: "@acme/security [click](https://evil.example)" });
    const ruled = rulesOutput([{ path: "src/owner.ts", patch: `@@ -0,0 +1 @@\n+export const owner = ${payload};` }]);
    await director.decide({ type: "message.received", message: { content: JSON.stringify(ruled) } } as ReactorInboundEvent, {} as ReactorState, caps);
    const systemOne = requests[0]?.providerOptions.systemOne;
    expect(systemOne.questions[0].instructions).toEndWith("Candidate label: acme/security click.");
    expect(systemOne.state.changeCandidates["focused-candidate-001"].label).toBe("acme/security click");
    const probabilities = { primary_or_supporting: 0.1, unrelated: 0.7, movement_or_superseded: 0.1, ambiguous: 0.1 };
    const text = JSON.stringify({ id: "focused-candidate-001", type: "choice", choice: "unrelated", probabilities, confidence: 0.9 });
    await director.decide({ type: "inference.done", turn: { content: [{ type: "text", text }] } } as ReactorInboundEvent, {} as ReactorState, caps);
    const verdict = await evaluate({ ...ruled, reply: judged }, ctx, signal) as Verdict;
    expect(verdict.feedback.split("\n").slice(1)).toEqual(["- Split out unrelated change: `acme/security click — src/owner.ts`"]);
  });

  test("replies without inference when focused has no candidates and no other questions", async () => {
    let inferred = 0;
    const replies: string[] = [];
    const caps = {
      infer() { inferred++; return { type: "infer" }; },
      reply(content: string) { replies.push(content); return { type: "reply", content }; },
    } as unknown as ReactorCapabilities;
    const director = triageDirectorFactory({ role: "judge" }, {} as never, { systemPrompt: "" } as never);
    await director.decide({
      type: "message.received",
      message: { content: JSON.stringify(rulesOutput([])) },
    } as ReactorInboundEvent, {} as ReactorState, caps);
    expect(inferred).toBe(0);
    expect(replies.map((reply) => JSON.parse(reply))).toEqual([{ answers: [{}] }]);
  });

  test("an oversized evaluation skips the judge and human-gates the verdict without accusation", async () => {
    const patch = Array.from({ length: 200 }, (_, index) => [
      `@@ -${index + 1} +${index + 1} @@`,
      `+// ${"evidence".repeat(27)}`,
      `+const value${index} = { name: "Candidate ${index}" };`,
    ].join("\n")).join("\n");
    const pack = { ...emptyPack("acme/widgets"), checks: { focused: { enabled: true } } };
    const ruled = await rules({ items: [{ facts: prFacts([{ path: "src/config.ts", patch }]), pack }], batch: false }, ctx, signal);
    expect(ruled.needsJudgment).toBe(false);
    expect(ruled.items[0]).toMatchObject({ judgeError: "quality evaluation exceeds the safe System One byte budget", judgeLimitExceeded: true });

    const verdict = await evaluate(ruled, ctx, signal) as Verdict;
    expect(verdict).toMatchObject({ mirror: false, humanGated: true, degraded: null, feedback: "" });
    expect(verdict.checks.filter((c) => c.kind === "model")).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: "decision model unavailable", evidence: [] }]);
    expect(verdict.reason).not.toContain("unrelated");
  });

  test("33 compact mixed questions skip the judge", async () => {
    const patch = Array.from({ length: 30 }, (_, index) => [
      `@@ -${index + 1} +${index + 1} @@`,
      `+const value${index} = { name: "Candidate ${index}" };`,
    ].join("\n")).join("\n");
    const pack = {
      ...emptyPack("acme/widgets"),
      checks: { focused: { enabled: true }, docs: { enabled: true }, tests: { enabled: true } },
      custom: [{ id: "custom-1", name: "Architecture", group: "code-vs-ci" as const, kind: "model" as const, shape: "is-true" as const, claim: "Keeps boundaries" }],
    };
    const ruled = await rules({ items: [{ facts: prFacts([{ path: "src/config.ts", patch }]), pack }], batch: false }, ctx, signal);
    expect(ruled.needsJudgment).toBe(false);
    expect(ruled.items[0]).toMatchObject({ judgeError: "quality evaluation exceeds the safe System One byte budget" });
  });
});

describe("mirror director cleanup mode", () => {
  const request = { repo: "acme/widgets", number: 8, labels: ["ready-monitoring"], owned: TRIAGE_LABELS, comment: "Looks good", close: false };
  const verdict = {
    repo: "acme/widgets",
    number: 8,
    state: "ready-monitoring",
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
