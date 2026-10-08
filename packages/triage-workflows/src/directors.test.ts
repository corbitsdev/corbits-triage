import { describe, expect, test } from "bun:test";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState, ToolCall } from "@intx/types/runtime";
import { triageDirectorFactory } from "./directors.js";
import { emptyPack } from "@corbits/triage-contracts";
import { NEEDS_SETUP_REASON } from "./logic/checks.js";

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

describe("mirror director cleanup mode", () => {
  const request = { repo: "acme/widgets", number: 8, labels: ["ready-monitoring"], comment: "Looks good", close: false };
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
