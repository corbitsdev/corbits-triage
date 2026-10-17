import { expect, test } from "bun:test";
import { guardedApp } from "./test-app.js";

const app = guardedApp({} as never, async () => null, {} as never, {});

async function validate(text: string): Promise<Response> {
  return app.request("/api/integrations/policy/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: "acme/widgets", text }) });
}

test("validating a policy file answers the policy it holds, or each problem with its line, without signing in", async () => {
  const valid = await validate("rules:\n  - check: ci-green\n    text: CI passes.\n    reason: Required.\n    evidence: [maintainer-stated]\n");
  expect(await valid.json()).toMatchObject({ ok: true, policy: { checks: { "ci-green": { enabled: true } } } });
  const refused = await validate("rules:\n  - check: focused\n    text: One change.\n    reason: Required.\n    evidence: [maintainer-stated]\n  - check: ci-green\n    text: CI passes.\n    evidence: [maintainer-stated]\n");
  expect(await refused.json()).toEqual({ ok: false, problems: [{ message: expect.stringContaining("reason must be"), line: 6 }] });
  expect((await validate("x".repeat(300 * 1024))).status).toBe(413);
});
