import { expect, test } from "bun:test";
import type { EffectContext } from "@intx/workflow";
import { report, reviewRequest, stop } from "./report.js";

const REQUEST = { kind: "code-review", number: 8, title: "Add the flag", description: "", diff: "diff --git a/f b/f", checkout: { source: "github", repo: "acme/widgets", sha: "h1" } };
const REPLY = { to: "run_manager", content: "{\"kind\":\"pr\"}" };
const MAIL = { headers: { from: "run_manager@acme.test", to: ["run_review@acme.test"] }, parts: [{ contentType: "text/plain", text: JSON.stringify({ ...REQUEST, tenantId: "tnt_acme", reply: REPLY }) }] };
const REVIEW = { summary: "No bugs.", comments: [], budgetExhausted: false };

/** Each effect runs once against a hub that records its calls and records the result. */
function hubContext() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  async function fetch(path: string, init?: RequestInit): Promise<Response> {
    calls.push({ method: init?.method ?? "GET", path, ...(init?.body !== undefined && { body: JSON.parse(String(init.body)) }) });
    return init?.method === "DELETE" ? new Response(null, { status: 202 }) : Response.json({ recorded: true });
  }
  const credentials = { resolve: async () => ({ kind: "http", fetch }) };
  const ctx = { perform: ({ run }: { run: (scope: unknown) => Promise<unknown> }) => run({ credentials }) } as unknown as EffectContext;
  return { ctx, calls };
}

test("a manager's code review hands its request to the review, reports the review through the hub, replies to the manager and stops, posting nothing", async () => {
  const { ctx, calls } = hubContext();
  expect(await reviewRequest(MAIL)).toEqual({ request: { ...REQUEST, tenantId: "tnt_acme", reply: REPLY } });
  expect(await report({ payload: MAIL, review: { output: REVIEW } }, ctx, new AbortController().signal)).toEqual({ recorded: true, mail: { tenantId: "tnt_acme", ...REPLY, fresh: false } });
  expect(await stop(MAIL, ctx, new AbortController().signal)).toEqual({ stopped: true });
  expect(calls).toEqual([
    { method: "POST", path: "/api/tenants/tnt_acme/manager/reviewer-result", body: { source: "github", repo: "acme/widgets", number: 8, kind: "code-review", head: "h1", result: REVIEW } },
    { method: "DELETE", path: "/api/tenants/tnt_acme/workflows/runs/run_review" },
  ]);
  await expect(reviewRequest({ ...MAIL, parts: [{ contentType: "text/plain", text: JSON.stringify(REQUEST) }] })).rejects.toThrow("the review mail");
});
