import { describe, expect, test } from "bun:test";
import { VerdictDetail } from "@corbits/triage-contracts";
import type { Transport } from "@intx/hub-client";
import { approveHeldDo, projectQueue, type PrItem } from "./hub-api.ts";
import { pendingDos } from "./pending-dos.ts";

const NOW = "2026-10-01T02:00:00.000Z";
const pull = { repo: "acme/widgets", number: 8 };

function step(kind: string, target: Record<string, unknown>, index = 0): Record<string, unknown> {
  return { list: "fail", index, effectId: `effect-${index}`, kind, held: true, reason: "Size failed.", target };
}

function verdict(actions: unknown[]): PrItem {
  const detail = VerdictDetail.assert({ labels: ["triage:needs-decision"], feedback: "Please split this.", actions });
  const recorded = {
    runId: "run-8", at: NOW, headSha: "abc", verdict: "fail" as const, settled: true, state: "needs-decision", actor: "maintainer", humanGated: true,
    degraded: null, commented: false, checks: [], detail,
  };
  const [item] = projectQueue([{ ...pull, source: "github", activityAt: null, verdict: recorded, run: null }], [], undefined);
  if (item === undefined) throw new Error("no verdict projected");
  return item;
}

describe("pendingDos", () => {
  test("each held kind is approved through the hub by reference only", async () => {
    const dos = pendingDos(verdict([
      step("labels", { labels: ["size/xl", "needs-split"] }, 0),
      step("assign", { users: ["alice"] }, 1),
      step("request-review", { users: ["bob"], teams: ["core"] }, 2),
      step("comment", { body: "Please split this." }, 3),
      step("close", {}, 4),
    ]));
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: Transport = {
      fetch: async (method, path, body) => {
        calls.push({ method, path, body });
        return { status: "sent" } as never;
      },
      subscribe: () => () => {},
    };
    for (const pending of dos) await approveHeldDo(transport, "t", pending.ref);
    expect(calls).toEqual(dos.map((pending, index) => ({
      method: "POST",
      path: "/api/integrations/github-held-dos/t",
      body: { runId: "run-8", ...pull, source: "github", effectId: `effect-${index}`, kind: pending.kind },
    })));
  });
});
