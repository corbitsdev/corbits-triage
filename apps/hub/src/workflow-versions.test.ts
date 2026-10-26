import { describe, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";
import { guardedApp } from "./integrations/test-app.js";
import { createWorkflowVersions } from "./workflow-versions.js";

const TENANT_ID = "tenant-1";
const CREATED_AT = new Date("2026-10-09T12:00:00Z");
const WORKFLOW = { name: "@corbits/pr-triage-workflow", version: "0.1.0-sha-1234abcd" };
const TOOL = { name: "@corbits/github-tool", version: "0.2.0" };
const SOURCE_WORKFLOW = { name: "@corbits/pr-triage-historical-workflow", version: "0.1.0-sha-5678ef01" };

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
      closure: { schemaVersion: "1", topLevel: [SOURCE_WORKFLOW], entries: [] },
    },
  },
};

const ROWS = [
  { runId: "run_tarball", workflow: "pr-triage", domain: "tenant.example", createdAt: CREATED_AT, cancellationRequestedAt: null },
  { runId: "run_source", workflow: "pr-triage-historical", domain: "tenant.example", createdAt: CREATED_AT, cancellationRequestedAt: CREATED_AT },
];

const WORKER_ROWS = [
  { runId: "run_tarball_worker", workflow: "pr-triage", domain: "tenant.example", createdAt: CREATED_AT, cancellationRequestedAt: null },
];

function db() {
  const pages = [ROWS, WORKER_ROWS];
  const chain = { from: () => chain, innerJoin: () => chain, leftJoin: () => chain, where: () => chain, orderBy: async () => pages.shift() };
  return {
    select: () => chain,
    query: {
      tenant: { async findFirst() { return { id: TENANT_ID }; } },
      principal: { async findFirst() { return { id: "member-1", status: "active" }; } },
    },
  } as never;
}

function handler() {
  return createWorkflowVersions({ db: db(), up: async (anchorRunId) => anchorRunId !== "run_source", launchSpecs: { get: async (anchorRunId) => (SPECS[anchorRunId.replace("_worker", "")] ?? null) as never } });
}

describe("createWorkflowVersions", () => {
  test("reads each live listener's and worker's workflow and tool versions from its frozen closure", async () => {
    const res = await handler()({ tenantId: TENANT_ID, principalId: "member-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deployments: [
        { id: "run_tarball", workflow: "pr-triage", createdAt: CREATED_AT.toISOString(), cancelling: false, live: true, worker: false, package: WORKFLOW, tools: [TOOL] },
        { id: "run_source", workflow: "pr-triage-historical", createdAt: CREATED_AT.toISOString(), cancelling: true, live: false, worker: false, package: SOURCE_WORKFLOW, tools: [] },
        { id: "run_tarball_worker", workflow: "pr-triage", createdAt: CREATED_AT.toISOString(), cancelling: false, live: true, worker: true, package: WORKFLOW, tools: [TOOL] },
      ],
    });
  });

  test("refuses a member without the workflow read grant with 403", async () => {
    const read = { id: "grt_read", resource: "workflow:*", action: "read", effect: "allow", origin: "system", conditions: null, expiresAt: null, roleId: null, principalId: "member-1" } as const;
    for (const [grants, status] of [[[], 403], [[read], 200]] as const) {
      const app = guardedApp(db(), async () => ({ user: { id: "user-1" } }) as never, createInMemoryGrantStore([...grants]), { workflowVersions: handler() });
      expect((await app.request(`/api/integrations/workflow-versions/${TENANT_ID}`)).status).toBe(status);
    }
  });
});
