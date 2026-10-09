import { describe, expect, test } from "bun:test";
import type { WorkflowAllocationService, WorkflowLifecycleService } from "@intx/hub-sessions";
import { createDeploymentRotation, resolveLiveDeployments } from "./deployment.js";

const TENANT_ID = "tnt_acme";
const SOURCE = { kind: "asset", assetId: "ast_triage", package: { format: "source", commitSha: "c0ffee", packageName: "@corbits/pr-triage-workflow" } };
const SPEC = {
  anchorRunId: "run_old",
  deploymentDomain: "acme.test",
  sourceAuthorityPrincipalId: "prn_deployer",
  sourceOfferingIds: ["off_a", "off_b"],
  defaultSourceOfferingId: "off_a",
  deployContent: { systemPrompt: "Triage pull requests." },
  frozenApprovalBundle: { source: SOURCE, entry: "./pr-triage.mjs" },
};

function selectReturning(rows: unknown[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: async () => rows,
  };
  return { select: () => chain } as never;
}

function rotation(status: string, mayDeploy = true) {
  const prepared: unknown[] = [];
  const allocation = {
    async prepareProvisionedDeployment(args: { anchorRunId: string }) {
      prepared.push(args);
      return { anchorRunId: args.anchorRunId, deploymentAddress: `${args.anchorRunId}@acme.test`, allocationId: "alc", status: "pending" };
    },
  } as unknown as WorkflowAllocationService;
  const rotate = createDeploymentRotation({
    db: { query: { principal: { findFirst: async () => ({ status }) } } } as never,
    launchSpecs: { get: async () => SPEC as never },
    allocation,
    lifecycle: {} as WorkflowLifecycleService,
    mayDeploy: async () => mayDeploy,
  });
  return { rotate, prepared };
}

describe("deployment rotation", () => {
  test("a copy is deployed from the replaced deployment's launch spec as its active, authorized deployer", async () => {
    const { rotate, prepared } = rotation("active");
    const redeployed = await rotate.redeploy(TENANT_ID, "run_old");
    expect(prepared).toEqual([{
      tenantId: TENANT_ID,
      anchorRunId: expect.not.stringMatching(/^run_old$/),
      deploymentDomain: "acme.test",
      source: SOURCE,
      entry: "./pr-triage.mjs",
      definitionAssetId: "ast_triage",
      sessionId: expect.any(String),
      sourceAuthorityPrincipalId: "prn_deployer",
      sourceOfferingIds: ["off_a", "off_b"],
      defaultSourceOfferingId: "off_a",
      deployContent: { systemPrompt: "Triage pull requests." },
    }]);
    expect(redeployed).toEqual({ status: "deployed", runId: (prepared[0] as { anchorRunId: string }).anchorRunId });
  });

  test("a deployer no longer active, or without the deploy grant, is not deployed as", async () => {
    const inactive = rotation("deactivated");
    expect(await inactive.rotate.redeploy(TENANT_ID, "run_old")).toEqual({ status: "skipped", reason: "deployer_inactive" });
    const denied = rotation("active", false);
    expect(await denied.rotate.redeploy(TENANT_ID, "run_old")).toEqual({ status: "skipped", reason: "deployer_not_authorized" });
    expect([...inactive.prepared, ...denied.prepared]).toEqual([]);
  });

  test("two deployments run the same source only when asset, commit and entry match", async () => {
    const moved = { ...SPEC, frozenApprovalBundle: { ...SPEC.frozenApprovalBundle, source: { ...SOURCE, package: { ...SOURCE.package, commitSha: "beef" } } } };
    const specs: Record<string, unknown> = { run_a: SPEC, run_b: SPEC, run_moved: moved };
    const rotate = createDeploymentRotation({
      db: {} as never,
      launchSpecs: { get: async (anchorRunId) => specs[anchorRunId] as never ?? null },
      allocation: {} as WorkflowAllocationService,
      lifecycle: {} as WorkflowLifecycleService,
      mayDeploy: async () => true,
    });
    expect(await rotate.sameSource("run_a", "run_b")).toBe(true);
    expect(await rotate.sameSource("run_a", "run_moved")).toBe(false);
    expect(await rotate.sameSource("run_a", "run_missing")).toBe(false);
  });

  test("a deployment whose cancellation was requested is listed as cancelling", async () => {
    const createdAt = new Date("2026-10-07T12:00:00.000Z");
    const db = selectReturning([
      { runId: "run_new", domain: "acme.test", createdAt, cancellationRequestedAt: null },
      { runId: "run_old", domain: "acme.test", createdAt, cancellationRequestedAt: createdAt },
    ]);
    expect(await resolveLiveDeployments(db, TENANT_ID, "pr-triage")).toEqual([
      { runId: "run_new", address: "run_new@acme.test", createdAt, cancelling: false },
      { runId: "run_old", address: "run_old@acme.test", createdAt, cancelling: true },
    ]);
  });
});
