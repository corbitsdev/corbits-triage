import { describe, expect, test } from "bun:test";
import type { Transport, WorkflowDeployment } from "@intx/hub-client";
import { cancelsSuperseded, ensureWorkflows } from "./workflow-deploy.ts";
import type { PackageIndexEntry } from "./workflow-packages.ts";

const OFFERINGS = { ids: ["mof_1"], defaultId: "mof_1" };
const INDEX: PackageIndexEntry[] = [
  { name: "@corbits/github-tool", version: "0.2.0", filename: "@corbits-github-tool-0.2.0.tgz", integrity: "sha512-tool" },
  { name: "@corbits/pr-triage-workflow", version: "0.1.0-sha-aaaaaaaa", filename: "@corbits-pr-triage-workflow-0.1.0-sha-aaaaaaaa.tgz", integrity: "sha512-triage" },
  { name: "@corbits/pr-triage-historical-workflow", version: "0.1.0-sha-bbbbbbbb", filename: "@corbits-pr-triage-historical-workflow-0.1.0-sha-bbbbbbbb.tgz", integrity: "sha512-historical" },
];

type Asset = { id: string; kind: string; name: string };

function packageOf(pin: string) {
  const at = pin.lastIndexOf("@");
  return { name: pin.slice(0, at), version: pin.slice(at + 1) };
}

/** The stock asset, tarball and deployment routes plus the hub's workflow-deploy and workflow-versions routes, as the portal calls them. */
function fakeHub(tarballSeed: Record<string, string> = {}) {
  const assets: Asset[] = [];
  const tarballs = new Map(Object.entries(tarballSeed));
  const deployments: WorkflowDeployment[] = [];
  const pins = new Map<string, string>();
  const requests: string[] = [];
  const deployed: unknown[] = [];

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    requests.push(`${method} ${path}`);
    const url = new URL(path, "http://hub");
    if (path === "/api/tenants/t") return (method === "GET" ? { config: {} } : undefined) as T;
    if (path === "/api/tenants/t/workflows/deployments") return deployments as T;
    if (path === "/api/integrations/workflow-versions/t") {
      const live = deployments.filter((row) => row.status === "deployed").reverse();
      return {
        deployments: live.map((row) => ({
          id: row.id,
          workflow: assets.find((asset) => asset.id === row.definitionAssetId)?.name,
          createdAt: row.createdAt,
          cancelling: false,
          package: packageOf(pins.get(row.id)!),
          tools: [{ name: INDEX[0]!.name, version: INDEX[0]!.version }],
        })),
      } as T;
    }
    if (method === "GET" && url.pathname === "/api/tenants/t/assets") {
      return assets.filter((asset) => asset.kind === url.searchParams.get("kind")) as T;
    }
    if (method === "POST" && path === "/api/tenants/t/assets") {
      const asset = { id: `ast_${assets.length + 1}`, ...(body as { kind: string; name: string }) };
      assets.push(asset);
      return asset as T;
    }
    if (method === "GET" && path.endsWith("/tarballs")) {
      return [...tarballs].map(([filename, integrity]) => ({ filename, integrity, size: 1 })) as T;
    }
    if (method === "POST" && path === "/api/integrations/workflow-deploy/t") {
      deployed.push(body);
      const { definitionAssetId, pin } = body as { definitionAssetId: string; pin: string };
      const deployment: WorkflowDeployment = {
        id: `run_${deployments.length + 1}`,
        tenantId: "t",
        definitionAssetId,
        status: "deployed",
        createdAt: `2026-10-09T00:00:0${deployments.length}.000Z`,
      };
      deployments.push(deployment);
      pins.set(deployment.id, pin);
      return deployment as T;
    }
    if (method === "DELETE") {
      const deployment = deployments.find((row) => path.endsWith(`/${row.id}`));
      if (deployment) deployment.status = "released";
      return undefined as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  }

  async function raw(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    if (path === "/packages/index.json") return Response.json(INDEX);
    if (method === "GET" && path.startsWith("/packages/")) return new Response(new Uint8Array([1]));
    if (method === "PUT") {
      const filename = decodeURIComponent(path.split("/").at(-1) ?? "");
      const integrity = INDEX.find((entry) => entry.filename === filename)?.integrity ?? "";
      tarballs.set(filename, integrity);
      return Response.json({ commit: "c", integrity });
    }
    throw new Error(`unexpected ${method} ${path}`);
  }

  const transport: Transport = { fetch: json, subscribe: () => () => {} };
  return { transport, fetchRaw: raw as typeof fetch, assets, tarballs, deployments, pins, requests, deployed };
}

function puts(requests: string[]): string[] {
  return requests.filter((line) => line.startsWith("PUT ")).map((line) => decodeURIComponent(line.split("/").at(-1) ?? ""));
}

describe("ensureWorkflows", () => {
  test("publishes the tool before the workflows to one corbits registry and deploys each workflow pinned to its version", async () => {
    const hub = fakeHub();
    expect(await ensureWorkflows(hub.transport, "t", OFFERINGS, false, hub.fetchRaw)).toEqual(["pr-triage", "pr-triage-historical"]);

    const registries = hub.assets.filter((asset) => asset.kind === "package-registry");
    expect(registries).toEqual([{ id: expect.any(String), kind: "package-registry", name: "corbits" }]);
    const registryId = registries[0]!.id;
    expect(hub.requests).toContain(`PUT /api/tenants/t/assets/${registryId}/tarballs/${encodeURIComponent(INDEX[0]!.filename)}`);
    expect(puts(hub.requests)).toEqual(INDEX.map((entry) => entry.filename));
    function workflowAsset(name: string) {
      return hub.assets.find((asset) => asset.kind === "workflow" && asset.name === name)?.id;
    }
    expect(hub.deployed).toEqual([
      {
        registryAssetId: registryId,
        definitionAssetId: workflowAsset("pr-triage"),
        pin: "@corbits/pr-triage-workflow@0.1.0-sha-aaaaaaaa",
        entry: "./pr-triage.mjs",
        sourceOfferingIds: ["mof_1"],
        defaultSourceOfferingId: "mof_1",
      },
      {
        registryAssetId: registryId,
        definitionAssetId: workflowAsset("pr-triage-historical"),
        pin: "@corbits/pr-triage-historical-workflow@0.1.0-sha-bbbbbbbb",
        entry: "./pr-triage-historical.mjs",
        sourceOfferingIds: ["mof_1"],
        defaultSourceOfferingId: "mof_1",
      },
    ]);
  });

  test("an unchanged build publishes and deploys nothing; a deployment of another version is redeployed though its tarball is already published", async () => {
    const hub = fakeHub();
    await ensureWorkflows(hub.transport, "t", OFFERINGS, false, hub.fetchRaw);
    hub.requests.length = 0;
    expect(await ensureWorkflows(hub.transport, "t", OFFERINGS, false, hub.fetchRaw)).toEqual([]);
    expect(puts(hub.requests)).toEqual([]);

    // A converge published this build, then its deploy failed: the live deployment still runs the older version.
    hub.pins.set("run_1", "@corbits/pr-triage-workflow@0.1.0-sha-00000000");
    expect(await ensureWorkflows(hub.transport, "t", OFFERINGS, false, hub.fetchRaw)).toEqual(["pr-triage"]);
    expect(puts(hub.requests)).toEqual([]);
    expect(hub.deployments.map((row) => [row.id, row.status])).toEqual([
      ["run_1", "released"],
      ["run_2", "deployed"],
      ["run_3", "deployed"],
    ]);
  });

  test("refuses to republish a version whose bytes changed, before publishing or deploying anything", async () => {
    const hub = fakeHub({ [INDEX[2]!.filename]: "sha512-other" });
    await expect(ensureWorkflows(hub.transport, "t", OFFERINGS, false, hub.fetchRaw))
      .rejects.toThrow("@corbits/pr-triage-historical-workflow@0.1.0-sha-bbbbbbbb is already published with different contents. Bump its version.");
    expect(puts(hub.requests)).toEqual([]);
    expect(hub.deployed).toEqual([]);
  });
});

describe("cancelsSuperseded", () => {
  test("pr-triage's superseded deployments are cancelled only right after a deploy; pr-triage-historical's on every converge", () => {
    expect([cancelsSuperseded("pr-triage", true), cancelsSuperseded("pr-triage", false)]).toEqual([true, false]);
    expect([cancelsSuperseded("pr-triage-historical", true), cancelsSuperseded("pr-triage-historical", false)]).toEqual([true, true]);
  });
});
