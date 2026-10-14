import { describe, expect, test } from "bun:test";
import type { PrepareProvisionedWorkflowDeploymentArgs } from "@intx/hub-sessions";
import { createInMemoryGrantStore } from "@intx/authz";
import { guardedApp } from "./integrations/test-app.js";
import { createWorkflowDeploy, type WorkflowDeployDeps } from "./workflow-deploy.js";

const TENANT_ID = "tenant-1";
const MEMBER = { tenantId: TENANT_ID, principalId: "member-1" };
const CREATED_AT = new Date("2026-10-09T12:00:00Z");
const BODY = {
  registryAssetId: "ast_registry",
  definitionAssetId: "ast_workflow",
  pin: "@corbits/pr-triage-workflow@0.1.0",
  entry: "./pr-triage.mjs",
  sourceOfferingIds: ["mof_1"],
  defaultSourceOfferingId: "mof_1",
};

type Calls = { prepared: PrepareProvisionedWorkflowDeploymentArgs[] };

const db = {
  query: {
    principal: { async findFirst() { return { id: "member-1", status: "active" }; } },
    tenant: { async findFirst() { return { id: TENANT_ID, domain: "tenant.example" }; } },
    asset: { async findFirst() { return { id: "asset" }; } },
    workflowRun: { async findFirst() { return { createdAt: CREATED_AT }; } },
    credential: { async findMany() { return [{ name: "github" }]; } },
  },
} as never;

function handler(calls: Calls, overrides: Partial<WorkflowDeployDeps> = {}) {
  return createWorkflowDeploy({
    db,
    allocation: {
      async prepareProvisionedDeployment(args) {
        calls.prepared.push(args);
        return { anchorRunId: args.anchorRunId, deploymentAddress: `${args.anchorRunId}@tenant.example`, allocationId: "alloc-1", status: "pending" };
      },
    },
    ...overrides,
  });
}

function calls(): Calls {
  return { prepared: [] };
}

describe("createWorkflowDeploy", () => {
  test("refuses a member without the workflow create grant with 403", async () => {
    const c = calls();
    const create = { id: "grt_create", resource: "workflow:*", action: "create", effect: "allow", origin: "system", conditions: null, expiresAt: null, roleId: null, principalId: "member-1" } as const;
    for (const [grants, status, prepared] of [[[], 403, 0], [[create], 201, 1]] as const) {
      const app = guardedApp(db, async () => ({ user: { id: "user-1" } }) as never, createInMemoryGrantStore([...grants]), { workflowDeploy: handler(c) });
      const res = await app.request(`/api/integrations/workflow-deploy/${TENANT_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify(BODY),
      });
      expect(res.status).toBe(status);
      expect(c.prepared).toHaveLength(prepared);
    }
  });

  test("deploys the registry tarball under the pin with the separate definition asset as the member", async () => {
    const c = calls();
    const res = await handler(c)(BODY, MEMBER);
    expect(c.prepared).toEqual([{
      tenantId: TENANT_ID,
      anchorRunId: expect.stringMatching(/^run_/),
      deploymentDomain: "tenant.example",
      source: { kind: "asset", assetId: "ast_registry", package: { format: "tarball" } },
      entry: "./pr-triage.mjs",
      pin: "@corbits/pr-triage-workflow@0.1.0",
      definitionAssetId: "ast_workflow",
      sessionId: expect.stringMatching(/^ses/),
      sourceAuthorityPrincipalId: "member-1",
      sourceOfferingIds: ["mof_1"],
      defaultSourceOfferingId: "mof_1",
      deployContent: { systemPrompt: "" },
    }]);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: c.prepared[0]!.anchorRunId,
      tenantId: TENANT_ID,
      definitionAssetId: "ast_workflow",
      status: "pending",
      createdAt: CREATED_AT.toISOString(),
    });
  });
});

function withCredentials(names: string[]) {
  return { query: { ...(db as { query: Record<string, unknown> }).query, credential: { async findMany() { return names.map((name) => ({ name })); } } } } as never;
}

test("deploys the pr-triage entry of the hosts the workspace connected, and refuses when none is", async () => {
  const both: Calls = { prepared: [] };
  expect((await handler(both, { db: withCredentials(["github", "bitbucket-datacenter"]) })(BODY, MEMBER)).status).toBe(201);
  expect(both.prepared[0]!.entry).toBe("./pr-triage-github-bitbucket-datacenter.mjs");
  const bitbucket: Calls = { prepared: [] };
  expect((await handler(bitbucket, { db: withCredentials(["bitbucket-datacenter"]) })(BODY, MEMBER)).status).toBe(201);
  expect(bitbucket.prepared[0]!.entry).toBe("./pr-triage-bitbucket-datacenter.mjs");
  const none: Calls = { prepared: [] };
  const res = await handler(none, { db: withCredentials([]) })(BODY, MEMBER);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "source_not_connected" } });
  expect(none.prepared).toHaveLength(0);
});
