import { expect, test } from "bun:test";
import type { EffectContext } from "@intx/workflow";
import { judgeRequest, report, stop } from "./report.js";

const RULES = { items: [{ facts: {} }], batch: false, chunks: [{ item: 0, state: {}, questions: [] }] };
const CHECKOUT = { source: "github", repo: "acme/widgets", sha: "h1" };
const MAIL = {
  headers: { from: "run_manager@acme.test", to: ["run_judge@acme.test"] },
  parts: [{ contentType: "text/plain", text: JSON.stringify({ kind: "judge", tenantId: "tnt_acme", number: 8, checkout: CHECKOUT, rules: RULES }) }],
};
const VERDICT = { repo: "acme/widgets", number: 8, headSha: "h1", verdict: "pass", reasons: ["Every rule passed."], checks: [], request: { repo: "acme/widgets", number: 8, comment: "Ready." }, automatic: ["labels"], actions: [] };

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

test("a manager's judge hands over the rules, reports the verdict through the hub and stops, posting nothing", async () => {
  const { ctx, calls } = hubContext();
  const signal = new AbortController().signal;
  expect(await judgeRequest(MAIL)).toEqual(RULES);
  expect(await report({ payload: MAIL, evaluate: { output: VERDICT }, judge: { output: [] } }, ctx, signal)).toEqual({ recorded: true });
  expect(await report({ payload: MAIL }, ctx, signal)).toEqual({ recorded: true });
  expect(await stop(MAIL, ctx, signal)).toEqual({ stopped: true });
  const reported = { source: "github", repo: "acme/widgets", number: 8, kind: "judge", head: "h1" };
  expect(calls).toEqual([
    { method: "POST", path: "/api/tenants/tnt_acme/manager/reviewer-result", body: { ...reported, result: VERDICT } },
    { method: "POST", path: "/api/tenants/tnt_acme/manager/reviewer-result", body: { ...reported, failed: "the judge did not finish" } },
    { method: "DELETE", path: "/api/tenants/tnt_acme/workflows/runs/run_judge" },
  ]);
  await expect(judgeRequest({ ...MAIL, parts: [{ contentType: "text/plain", text: JSON.stringify({ kind: "judge" }) }] })).rejects.toThrow("the judge mail");
});
