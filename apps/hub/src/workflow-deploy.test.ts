import { describe, expect, test } from "bun:test";
import type { PrepareProvisionedWorkflowDeploymentArgs } from "@intx/hub-sessions";
import { createWorkflowDeploy, type WorkflowDeployDeps } from "./workflow-deploy.js";

const TENANT_ID = "tenant-1";
const PORTAL = "https://portal.example";
const CREATED_AT = new Date("2026-10-09T12:00:00Z");
const BODY = {
  registryAssetId: "ast_registry",
  definitionAssetId: "ast_workflow",
  pin: "@corbits/pr-triage-workflow@0.1.0",
  entry: "./pr-triage.mjs",
  sourceOfferingIds: ["mof_1"],
  defaultSourceOfferingId: "mof_1",
};

type Calls = { prepared: PrepareProvisionedWorkflowDeploymentArgs[]; authorized: unknown[][] };

const db = {
  query: {
    principal: { async findFirst() { return { id: "member-1" }; } },
    tenant: { async findFirst() { return { domain: "tenant.example" }; } },
    asset: { async findFirst() { return { id: "asset" }; } },
    workflowRun: { async findFirst() { return { createdAt: CREATED_AT }; } },
  },
} as never;

function handler(calls: Calls, overrides: Partial<WorkflowDeployDeps> = {}) {
  return createWorkflowDeploy({
    db,
    cipher: {} as never,
    getSession: async () => ({ user: { id: "user-1" } }),
    authorize: async (...args) => {
      calls.authorized.push(args);
      return true;
    },
    trustedPortalOrigins: [PORTAL],
    allocation: {
      async prepareProvisionedDeployment(args) {
        calls.prepared.push(args);
        return { anchorRunId: args.anchorRunId, deploymentAddress: `${args.anchorRunId}@tenant.example`, allocationId: "alloc-1", status: "pending" };
      },
    },
    ...overrides,
  });
}

function request(): Request {
  return new Request(`https://hub.example/api/integrations/workflow-deploy/${TENANT_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: PORTAL, "sec-fetch-site": "same-site" },
    body: JSON.stringify(BODY),
  });
}

function calls(): Calls {
  return { prepared: [], authorized: [] };
}

describe("createWorkflowDeploy", () => {
  test("refuses a member without the workflow create grant with 403", async () => {
    const c = calls();
    const authorize: WorkflowDeployDeps["authorize"] = async (...args) => {
      c.authorized.push(args);
      return false;
    };
    const res = await handler(c, { authorize })(request(), TENANT_ID);
    expect(res.status).toBe(403);
    expect(c.authorized).toEqual([["member-1", TENANT_ID, "workflow:*", "create"]]);
    expect(c.prepared).toEqual([]);
  });

  test("deploys the registry tarball under the pin with the separate definition asset as the member", async () => {
    const c = calls();
    const res = await handler(c)(request(), TENANT_ID);
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
