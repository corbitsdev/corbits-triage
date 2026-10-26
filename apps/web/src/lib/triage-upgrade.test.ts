import { expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { restartListener, upgradeTriage, type UpgradeStep } from "./triage-upgrade.ts";
import type { PublishedSource } from "./workflow-sources.ts";

const PUBLISHER = { tenantId: "t", principalId: "prn_deployer" };
const PUBLISHED: PublishedSource[] = [
  { workflow: "triage-manager-github", assetId: "ast_manager", commitSha: "m1" },
  { workflow: "triage-listener-github", assetId: "ast_listener", commitSha: "l1" },
];

/** Live listeners one the owner and another Deployer published, the workflows they replace, a manager, and another host's pr-triage. */
function fakeHub() {
  const deployments = [
    { id: "run_owner", tenantId: "t", definitionAssetId: "ast_owner_listener", status: "deployed", createdAt: "2026-10-01T00:00:00.000Z" },
    { id: "run_other", tenantId: "t", definitionAssetId: "ast_other_listener", status: "deployed", createdAt: "2026-10-02T00:00:00.000Z" },
    { id: "run_triage", tenantId: "t", definitionAssetId: "ast_triage", status: "deployed", createdAt: "2026-10-02T00:00:00.000Z" },
    { id: "run_review", tenantId: "t", definitionAssetId: "ast_review", status: "deployed", createdAt: "2026-10-02T00:00:00.000Z" },
    { id: "run_manager", tenantId: "t", definitionAssetId: "ast_manager", status: "deployed", createdAt: "2026-10-02T00:00:00.000Z" },
    { id: "run_bitbucket", tenantId: "t", definitionAssetId: "ast_bitbucket", status: "deployed", createdAt: "2026-10-02T00:00:00.000Z" },
  ];
  const workflows: Record<string, string> = {
    run_owner: "triage-listener-github",
    run_other: "triage-listener-github",
    run_triage: "pr-triage-github",
    run_review: "pr-code-review-github",
    run_manager: "triage-manager-github",
    run_bitbucket: "pr-triage-bitbucket-datacenter",
  };
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    requests.push({ method, path, ...(body !== undefined && { body }) });
    if (method === "GET" && path === "/api/tenants/t") return { config: {} } as T;
    if (method === "PATCH" && path === "/api/tenants/t") return undefined as T;
    if (path === "/api/tenants/t/models") return [{ canonicalName: "decision", offerings: [{ offeringId: "mof_1", providerName: "corbits-system-one" }] }] as T;
    if (method === "POST" && path === "/api/tenants/t/workflows/deployments") {
      const created = { id: "run_new", tenantId: "t", definitionAssetId: "ast_listener", status: "deployed", createdAt: "2026-10-03T00:00:00.000Z" };
      deployments.push(created);
      workflows["run_new"] = "triage-listener-github";
      return created as T;
    }
    if (path === "/api/tenants/t/workflows/deployments") return deployments as T;
    if (path === "/api/integrations/workflow-versions/t") {
      return { deployments: deployments.filter((row) => row.status === "deployed").map((row) => ({ id: row.id, workflow: workflows[row.id], createdAt: row.createdAt, cancelling: false, live: true, worker: false, package: null, tools: [], source: { assetId: row.definitionAssetId, commitSha: `c_${row.id}` } })) } as T;
    }
    if (method === "DELETE" && path.startsWith("/api/tenants/t/workflows/runs/")) {
      deployments.find((row) => path.endsWith(row.id))!.status = "cancelled";
      return undefined as T;
    }
    throw new Error(`Unexpected ${method} ${path}`);
  }
  return { transport: { fetch: json } as unknown as Transport, requests };
}

test("an upgrade deploys the listener from its published source, then stops the host's other listeners, whoever published them, and the workflows it replaces", async () => {
  const hub = fakeHub();
  const steps: UpgradeStep[] = [];
  await upgradeTriage(hub.transport, PUBLISHER, ["github"], (step) => steps.push(step), async () => PUBLISHED);

  expect(steps).toEqual(["publishing", "starting", "stopping"]);
  expect(hub.requests).toContainEqual({ method: "PATCH", path: "/api/tenants/t", body: { config: { lifecycle: { maxLifetime: "36500d" } } } });
  expect(hub.requests.find((row) => row.method === "POST")?.body).toEqual({
    source: { kind: "asset", assetId: "ast_listener", package: { format: "source", commitSha: "l1", packageName: "@corbits/triage-listener-github-workflow" } },
    entry: "./triage-listener-github.mjs",
    sourceOfferingIds: ["mof_1"],
    defaultSourceOfferingId: "mof_1",
  });
  expect(hub.requests.filter((row) => row.method === "DELETE").map((row) => row.path)).toEqual([
    "/api/tenants/t/workflows/runs/run_owner",
    "/api/tenants/t/workflows/runs/run_other",
    "/api/tenants/t/workflows/runs/run_triage",
    "/api/tenants/t/workflows/runs/run_review",
  ]);
});

test("restarting a host's listener after a credential is replaced deploys its newest listener again from the same source and stops the older ones", async () => {
  const hub = fakeHub();
  await restartListener(hub.transport, "t", "github");
  expect(hub.requests.find((row) => row.method === "POST")?.body).toMatchObject({
    source: { kind: "asset", assetId: "ast_other_listener", package: { format: "source", commitSha: "c_run_other", packageName: "@corbits/triage-listener-github-workflow" } },
  });
  expect(hub.requests.filter((row) => row.method === "DELETE").map((row) => row.path)).toEqual(expect.arrayContaining([
    "/api/tenants/t/workflows/runs/run_owner",
    "/api/tenants/t/workflows/runs/run_other",
  ]));
  expect(hub.requests.some((row) => row.path.endsWith("run_manager") || row.path.endsWith("run_bitbucket"))).toBe(false);
});

type Row = { id: string; tenantId: string; definitionAssetId: string; status: string; createdAt: string };

function sharedHub() {
  const deployments: Row[] = [{ id: "run_old", tenantId: "t", definitionAssetId: "ast_old", status: "deployed", createdAt: "2026-10-01T00:00:00.000Z" }];
  let n = 0;
  function transportFor(who: string): Transport {
    async function json<T>(method: string, path: string): Promise<T> {
      await Promise.resolve();
      if (method === "GET" && path === "/api/tenants/t") return { config: {} } as T;
    if (method === "PATCH" && path === "/api/tenants/t") return undefined as T;
    if (path === "/api/tenants/t/models") return [{ canonicalName: "decision", offerings: [{ offeringId: "mof_1", providerName: "corbits-system-one" }] }] as T;
      if (method === "POST" && path === "/api/tenants/t/workflows/deployments") {
        const created = { id: `run_${who}`, tenantId: "t", definitionAssetId: `ast_${who}`, status: "deployed", createdAt: `2026-10-03T00:00:0${n++}.000Z` };
        deployments.push(created);
        return created as T;
      }
      if (path === "/api/tenants/t/workflows/deployments") return deployments.map((row) => ({ ...row })) as T;
      if (path === "/api/integrations/workflow-versions/t") {
        return { deployments: deployments.filter((row) => row.status === "deployed").map((row) => ({ id: row.id, workflow: "triage-listener-github", createdAt: row.createdAt, cancelling: false, live: true, worker: false, package: null, tools: [], source: null })) } as T;
      }
      if (method === "DELETE" && path.startsWith("/api/tenants/t/workflows/runs/")) {
        deployments.find((row) => path.endsWith(row.id))!.status = "cancelled";
        return undefined as T;
      }
      throw new Error(`Unexpected ${method} ${path}`);
    }
    return { fetch: json } as unknown as Transport;
  }
  return { deployments, transportFor };
}

test("two Deployers upgrading at once leave exactly one listener live", async () => {
  const hub = sharedHub();
  function published(who: string) {
    return async () => [{ workflow: "triage-listener-github", assetId: `ast_${who}`, commitSha: who }];
  }
  const settled = await Promise.allSettled([
    upgradeTriage(hub.transportFor("a"), { tenantId: "t", principalId: "prn_a" }, ["github"], () => {}, published("a")),
    upgradeTriage(hub.transportFor("b"), { tenantId: "t", principalId: "prn_b" }, ["github"], () => {}, published("b")),
  ]);
  expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  // The upgrade whose listener the other stopped says so.
  const stopped = ["a", "b"].map((who) => hub.deployments.find((row) => row.id === `run_${who}`)!.status === "cancelled");
  expect(settled.map((result) => result.status === "fulfilled" && result.value.includes("github"))).toEqual(stopped);
  expect(hub.deployments.filter((row) => row.status === "deployed")).toHaveLength(1);
});
