import { expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { upgradeTriage, type UpgradeStep } from "./triage-upgrade.ts";
import type { PublishedSource } from "./workflow-sources.ts";

const PUBLISHER = { tenantId: "t", principalId: "prn_deployer" };
const PUBLISHED: PublishedSource[] = [
  { workflow: "triage-manager-github", assetId: "ast_manager", commitSha: "m1" },
  { workflow: "triage-listener-github", assetId: "ast_listener", commitSha: "l1" },
];

/** Live listeners: one the owner published, one another Deployer published, and another workflow's. */
function fakeHub() {
  const deployments = [
    { id: "run_owner", tenantId: "t", definitionAssetId: "ast_owner_listener", status: "deployed", createdAt: "2026-10-01T00:00:00.000Z" },
    { id: "run_other", tenantId: "t", definitionAssetId: "ast_other_listener", status: "deployed", createdAt: "2026-10-02T00:00:00.000Z" },
    { id: "run_triage", tenantId: "t", definitionAssetId: "ast_triage", status: "deployed", createdAt: "2026-10-02T00:00:00.000Z" },
  ];
  const workflows: Record<string, string> = { run_owner: "triage-listener-github", run_other: "triage-listener-github", run_triage: "pr-triage-github" };
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    requests.push({ method, path, ...(body !== undefined && { body }) });
    if (path === "/api/tenants/t/models") return [{ canonicalName: "decision", offerings: [{ offeringId: "mof_1", providerName: "corbits-system-one" }] }] as T;
    if (method === "POST" && path === "/api/tenants/t/workflows/deployments") {
      const created = { id: "run_new", tenantId: "t", definitionAssetId: "ast_listener", status: "deployed", createdAt: "2026-10-03T00:00:00.000Z" };
      deployments.push(created);
      workflows["run_new"] = "triage-listener-github";
      return created as T;
    }
    if (path === "/api/tenants/t/workflows/deployments") return deployments as T;
    if (path === "/api/integrations/workflow-versions/t") {
      return { deployments: deployments.filter((row) => row.status === "deployed").map((row) => ({ id: row.id, workflow: workflows[row.id], createdAt: row.createdAt, cancelling: false, worker: false, package: null, tools: [] })) } as T;
    }
    if (method === "DELETE" && path.startsWith("/api/tenants/t/workflows/runs/")) {
      deployments.find((row) => path.endsWith(row.id))!.status = "cancelled";
      return undefined as T;
    }
    throw new Error(`Unexpected ${method} ${path}`);
  }
  return { transport: { fetch: json } as unknown as Transport, requests };
}

test("an upgrade deploys the listener from its published source, then stops every other listener of the host, whoever published it", async () => {
  const hub = fakeHub();
  const steps: UpgradeStep[] = [];
  await upgradeTriage(hub.transport, PUBLISHER, ["github"], (step) => steps.push(step), async () => PUBLISHED);

  expect(steps).toEqual(["publishing", "starting", "stopping"]);
  expect(hub.requests.find((row) => row.method === "POST")?.body).toEqual({
    source: { kind: "asset", assetId: "ast_listener", package: { format: "source", commitSha: "l1", packageName: "@corbits/triage-listener-github-workflow" } },
    entry: "./triage-listener-github.mjs",
    sourceOfferingIds: ["mof_1"],
    defaultSourceOfferingId: "mof_1",
  });
  expect(hub.requests.filter((row) => row.method === "DELETE").map((row) => row.path)).toEqual([
    "/api/tenants/t/workflows/runs/run_owner",
    "/api/tenants/t/workflows/runs/run_other",
  ]);
});
