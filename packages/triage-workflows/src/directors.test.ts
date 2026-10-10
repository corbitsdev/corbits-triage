import { describe, expect, test } from "bun:test";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState, ToolCall } from "@intx/types/runtime";
import { triageDirectorFactory } from "./directors.js";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import { TRIAGE_LABELS } from "@corbits/rule-packs";
import { NEEDS_SETUP_REASON } from "./logic/checks.js";
import type { Verdict } from "./logic/render.js";

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
          policy: { checks: { draft: false } },
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
      result: { callId: "files:8", content: { files: [] } },
    } as ReactorInboundEvent);
    await decide({
      type: "tool.done",
      result: { callId: "comments:8", content: { comments: [] } },
    } as ReactorInboundEvent);
    await decide({
      type: "tool.done",
      result: { callId: "checks:8", content: { checks: [] } },
    } as ReactorInboundEvent);
    const body = JSON.parse(replies[0] ?? "{}") as { det?: { findings: Array<{ check: string }> } };
    expect(body.det?.findings.map((finding) => finding.check) ?? []).not.toContain("draft");
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
    expect(await fetched(false)).toEqual(["pr:8", "reviews:8", "commits:8", "files:8"]);
    expect((await fetched(true)).filter((id) => id.startsWith("pr:"))).toEqual(["pr:7", "pr:8"]);
  });

  test("a disabled repository replies a degraded item without fetching", async () => {
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
    expect(JSON.parse(replies[0] ?? "{}")).toMatchObject({
      det: { state: "stale-unknown", reason: "Triage is disabled for this repository.", needsJudgment: false },
    });
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
    expect(JSON.parse(replies[0] ?? "{}")).toMatchObject({
      det: { state: "stale-unknown", reason: NEEDS_SETUP_REASON, needsJudgment: false },
    });
  });
});

describe("judge on a blocked pull request", () => {
  function director(role: "facts" | "judge" | "render", caps: Partial<Record<"executeTools" | "reply" | "infer", unknown>>) {
    const d = triageDirectorFactory({ role }, {} as never, { systemPrompt: "" } as never);
    return (event: unknown) => d.decide(event as ReactorInboundEvent, {} as ReactorState, caps as unknown as ReactorCapabilities);
  }

  async function facts(checkRuns: unknown[], mergeable: boolean | null, draft = false, setup: Record<string, unknown> = {}): Promise<string> {
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
      "files:8": { files: [] },
      "comments:8": { comments: [] },
      "checks:8": { checks: checkRuns },
    };
    for (const [callId, content] of Object.entries(results)) await decide({ type: "tool.done", result: { callId, content } });
    return reply;
  }

  async function judgeAndRender(factsReply: string, judgeError?: string, failing = ["focused"]): Promise<{ asked: string[]; verdict: Verdict }> {
    let judged = "";
    const asked: string[] = [];
    const judge = director("judge", {
      infer(request: { providerOptions: { systemOne: { questions: Array<{ id: string }> } } }) {
        asked.push(...request.providerOptions.systemOne.questions.map((q) => q.id));
        return { type: "infer" };
      },
      reply(content: string) { judged = content; return { type: "reply", content }; },
    });
    await judge({ type: "message.received", message: { content: JSON.stringify({ reply: factsReply }) } });
    if (asked.length && judgeError !== undefined) await judge({ type: "inference.error", error: { message: judgeError } });
    else if (asked.length) {
      const text = asked.map((id) => JSON.stringify({ id, type: "noul", noul: failing.includes(id) ? 0.1 : 0.9 })).join("");
      await judge({ type: "inference.done", turn: { content: [{ type: "text", text }] } });
    }
    let rendered = "";
    const render = director("render", { reply(content: string) { rendered = content; return { type: "reply", content }; } });
    await render({ type: "message.received", message: { content: JSON.stringify({ reply: judged }) } });
    return { asked, verdict: JSON.parse(rendered) };
  }

  test("a CI-blocked pull request records the model's answers but stays driven by CI", async () => {
    const { asked, verdict } = await judgeAndRender(await facts([{ name: "build", status: "completed", conclusion: "failure" }], true));
    expect(asked).toEqual(["focused", "docs", "tests"]);
    expect(verdict).toMatchObject({ state: "blocked", reason: "required checks are failing", actor: "author", nextAction: "Fix failing CI: build" });
    expect(verdict.feedback).not.toContain("unrelated");
    expect(verdict.checks.filter((c) => c.kind === "model")).toEqual([
      { check: "focused", kind: "model", result: "fail", reason: "mixes unrelated changes", evidence: [] },
      { check: "docs", kind: "model", result: "pass", reason: "documentation is up to date", evidence: [] },
      { check: "tests", kind: "model", result: "pass", reason: "tests cover the change", evidence: [] },
    ]);
  });

  test("a judge outage on a blocked pull request leaves the verdict settled", async () => {
    const { verdict } = await judgeAndRender(await facts([{ name: "build", status: "completed", conclusion: "failure" }], true), "upstream 503");
    expect(verdict).toMatchObject({ state: "blocked", degraded: null, mirror: true });
    expect(verdict.checks.some((c) => c.kind === "machine" && c.result === "unconfirmed")).toBe(false);
    expect(verdict.checks.filter((c) => c.kind === "model").map((c) => c.reason)).toEqual(["decision model unavailable", "decision model unavailable", "decision model unavailable"]);
  });

  test("a clean draft awaits review with an informational draft check and labels only", async () => {
    const { asked, verdict } = await judgeAndRender(await facts([], true, true), undefined, []);
    expect(asked).toEqual(["focused", "docs", "tests"]);
    expect(verdict).toMatchObject({ state: "awaiting-review", degraded: null, mirror: true, feedback: "", actor: "maintainer", nextAction: "Review once marked ready" });
    expect(verdict.checks.find((c) => c.check === "draft")).toEqual({ check: "draft", kind: "machine", result: "fail", reason: "pull request is a draft", evidence: [] });
    expect(verdict.request).toEqual({ repo: "acme/widgets", number: 8, labels: verdict.labels, owned: TRIAGE_LABELS, comment: "", close: false });
  });

  test("a degraded verdict suggests no actions", async () => {
    const checkPack = { ...recommendedPack("acme/widgets"), actions: [{ id: "hello", when: "every", checks: [], branches: { always: [{ kind: "comment", automatic: false, target: { body: "hi" } }] } }] };
    const { verdict } = await judgeAndRender(await facts([], true, false, { checkPack }), "upstream 503");
    expect(verdict.degraded).toBe("inference-outage");
    expect(verdict.actions).toEqual([]);
  });

  test("suggests a pack action matched on a model check, resolved through the policy's roles", async () => {
    const checkPack = {
      ...recommendedPack("acme/widgets"),
      actions: [{ id: "ask-leads", when: "every", checks: ["focused"], branches: { no: [{ kind: "request-review", automatic: true, target: { to: "role", role: "leads" } }] } }],
    };
    const policy = { enabled: true, roles: { leads: { users: ["dave"] } } };
    const { verdict } = await judgeAndRender(await facts([], true, false, { policy, checkPack }));
    expect(verdict.actions).toEqual([
      { id: "ask-leads", branch: "no", kind: "request-review", automatic: true, target: { users: ["dave"], teams: [] }, reason: "Focused change failed." },
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
    const { verdict } = await judgeAndRender(await facts([], true, false, { checkPack }), undefined, ["custom-3"]);
    expect(verdict.actions).toEqual([
      { id: "on-3", branch: "no", kind: "comment", automatic: false, target: { body: "changelog" }, reason: "Changelog failed." },
    ]);
  });

  test("stale-unknown facts skip the model", async () => {
    const { asked, verdict } = await judgeAndRender(await facts([], null));
    expect(asked).toEqual([]);
    expect(verdict.state).toBe("stale-unknown");
    expect(verdict.checks.filter((c) => c.kind === "model").map((c) => c.reason)).toEqual(["not asked", "not asked", "not asked"]);
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
        id: "github_mirror_auto:acme/widgets#8",
        name: "github_mirror_auto",
        arguments: request,
      },
    ]]);
  });

  test("human-approved never calls a tool", async () => {
    expect(await mirrorCalls({ ...verdict, cleanupMode: "human-approved" })).toEqual([]);
  });
});
