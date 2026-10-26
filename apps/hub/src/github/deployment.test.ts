import { describe, expect, test } from "bun:test";
import { resolveLiveDeployments } from "./deployment.js";

const TENANT_ID = "tnt_acme";
function selectReturning(rows: unknown[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: async () => rows,
  };
  return { select: () => chain } as never;
}

describe("deployments", () => {
  test("a deployment whose cancellation was requested is listed as cancelling", async () => {
    const createdAt = new Date("2026-10-07T12:00:00.000Z");
    const db = selectReturning([
      { runId: "run_new", workflow: "triage-listener-github", domain: "acme.test", createdAt, cancellationRequestedAt: null },
      { runId: "run_old", workflow: "triage-listener-github", domain: "acme.test", createdAt, cancellationRequestedAt: createdAt },
    ]);
    expect(await resolveLiveDeployments(db, TENANT_ID, "triage-listener-github")).toEqual([
      { runId: "run_new", address: "run_new@acme.test", createdAt, cancelling: false, workflow: "triage-listener-github" },
      { runId: "run_old", address: "run_old@acme.test", createdAt, cancelling: true, workflow: "triage-listener-github" },
    ]);
  });
});
