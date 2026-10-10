import { describe, expect, test } from "bun:test";
import { createWorkflowVersions, type WorkflowVersionsDeps } from "./workflow-versions.js";

const TENANT_ID = "tenant-1";
const CREATED_AT = new Date("2026-10-09T12:00:00Z");
const WORKFLOW = { name: "@corbits/pr-triage-workflow", version: "0.1.0-sha-1234abcd" };
const TOOL = { name: "@corbits/github-tool", version: "0.2.0" };

function tarball(pkg: { name: string; version: string }) {
  return { ...pkg, source: { kind: "asset", assetId: "ast_corbits", package: { format: "tarball", path: `tarballs/${pkg.version}.tgz`, integrity: "sha512-AAAA" } } };
}

const SPECS: Record<string, unknown> = {
  run_tarball: {
    frozenApprovalBundle: {
      source: { kind: "asset", assetId: "ast_corbits", package: { format: "tarball" } },
      entry: "./pr-triage.mjs",
      closure: { schemaVersion: "1", topLevel: [WORKFLOW], entries: [tarball(WORKFLOW), tarball(TOOL)] },
    },
  },
  run_source: {
    frozenApprovalBundle: {
      source: { kind: "asset", assetId: "ast_triage", package: { format: "source", commitSha: "c0ffee", packageName: "@corbits/pr-triage-historical-workflow" } },
      entry: "./pr-triage-historical.mjs",
      closure: { schemaVersion: "1", topLevel: [], entries: [] },
    },
  },
};

const ROWS = [
  { runId: "run_tarball", workflow: "pr-triage", domain: "tenant.example", createdAt: CREATED_AT, cancellationRequestedAt: null },
  { runId: "run_source", workflow: "pr-triage-historical", domain: "tenant.example", createdAt: CREATED_AT, cancellationRequestedAt: CREATED_AT },
];

function db() {
  const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, orderBy: async () => ROWS };
  return {
    select: () => chain,
    query: { principal: { async findFirst() { return { id: "member-1" }; } } },
  } as never;
}

function handler(authorize: WorkflowVersionsDeps["authorize"] = async () => true) {
  return createWorkflowVersions({
    db: db(),
    cipher: {} as never,
    getSession: async () => ({ user: { id: "user-1" } }),
    authorize,
    trustedPortalOrigins: [],
    launchSpecs: { get: async (anchorRunId) => (SPECS[anchorRunId] ?? null) as never },
  });
}

function request(): Request {
  return new Request(`https://hub.example/api/integrations/workflow-versions/${TENANT_ID}`, { headers: { "sec-fetch-site": "same-origin" } });
}

describe("createWorkflowVersions", () => {
  test("reads each live deployment's workflow and tool versions from its frozen closure", async () => {
    const res = await handler()(request(), TENANT_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deployments: [
        { id: "run_tarball", workflow: "pr-triage", createdAt: CREATED_AT.toISOString(), cancelling: false, package: WORKFLOW, tools: [TOOL] },
        { id: "run_source", workflow: "pr-triage-historical", createdAt: CREATED_AT.toISOString(), cancelling: true, package: null, tools: [] },
      ],
    });
  });

  test("refuses a member without the workflow read grant with 403", async () => {
    const authorized: unknown[][] = [];
    const res = await handler(async (...args) => {
      authorized.push(args);
      return false;
    })(request(), TENANT_ID);
    expect(res.status).toBe(403);
    expect(authorized).toEqual([["member-1", TENANT_ID, "workflow:*", "read"]]);
  });
});
