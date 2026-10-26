import { describe, expect, test } from "bun:test";
import { ApiError, type Transport, type WorkflowDeployment } from "@intx/hub-client";
import { cancelsSuperseded, CREDENTIAL_HOLDERS, ensureWorkflows } from "./workflow-deploy.ts";
import type { PackageIndexEntry } from "./workflow-packages.ts";

const DECISION = [{ canonicalName: "decision", offerings: [{ offeringId: "mof_1", providerName: "corbits-system-one" }] }];
const BOTH = { connected: ["github", "bitbucket-datacenter"], codeReview: [], codeReviewProvider: "anthropic", prWorkflow: [] } as const;
const GITHUB = { connected: ["github"], codeReview: [], codeReviewProvider: "anthropic", prWorkflow: [] } as const;
const MISSING = new Set<never>();
const INDEX: PackageIndexEntry[] = [
  { name: "@corbits/github-tool", version: "0.2.0", filename: "@corbits-github-tool-0.2.0.tgz", integrity: "sha512-tool" },
  { name: "@corbits/pr-triage-github-workflow", version: "0.1.0-sha-aaaaaaaa", filename: "@corbits-pr-triage-github-workflow-0.1.0-sha-aaaaaaaa.tgz", integrity: "sha512-triage" },
  { name: "@corbits/pr-triage-bitbucket-datacenter-workflow", version: "0.1.0-sha-cccccccc", filename: "@corbits-pr-triage-bitbucket-datacenter-workflow-0.1.0-sha-cccccccc.tgz", integrity: "sha512-bitbucket" },
  { name: "@corbits/pr-triage-historical-workflow", version: "0.1.0-sha-bbbbbbbb", filename: "@corbits-pr-triage-historical-workflow-0.1.0-sha-bbbbbbbb.tgz", integrity: "sha512-historical" },
  { name: "@corbits/pr-code-review-github-workflow", version: "0.1.0-sha-dddddddd", filename: "@corbits-pr-code-review-github-workflow-0.1.0-sha-dddddddd.tgz", integrity: "sha512-review" },
  { name: "@corbits/pr-workflow-anthropic-github-workflow", version: "0.1.0-sha-eeeeeeee", filename: "@corbits-pr-workflow-anthropic-github-workflow-0.1.0-sha-eeeeeeee.tgz", integrity: "sha512-pr-workflow" },
];

type Asset = { id: string; kind: string; name: string };

function packageOf(pin: string) {
  const at = pin.lastIndexOf("@");
  return { name: pin.slice(0, at), version: pin.slice(at + 1) };
}

function fakeHub(tarballSeed: Record<string, string> = {}, unconnected: readonly string[] = [], models: unknown[] = DECISION) {
  const assets: Asset[] = [];
  const tarballs = new Map(Object.entries(tarballSeed));
  const deployments: WorkflowDeployment[] = [];
  const pins = new Map<string, string>();
  const requests: string[] = [];
  const deployed: unknown[] = [];
  const workers: Array<{ package: { name: string; version: string }; tools: Array<{ name: string; version: string }> }> = [];

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    requests.push(`${method} ${path}`);
    const url = new URL(path, "http://hub");
    if (path === "/api/tenants/t") return (method === "GET" ? { config: {} } : undefined) as T;
    if (path === "/api/tenants/t/workflows/deployments") return deployments as T;
    if (path === "/api/tenants/t/models") return models as T;
    if (path === "/api/integrations/workflow-versions/t") {
      const live = deployments.filter((row) => row.status === "deployed").reverse();
      const listeners = live.map((row) => ({
        id: row.id,
        workflow: assets.find((asset) => asset.id === row.definitionAssetId)?.name,
        createdAt: row.createdAt,
        cancelling: false,
        worker: false,
        package: packageOf(pins.get(row.id)!),
        tools: [{ name: INDEX[0]!.name, version: INDEX[0]!.version }],
      }));
      const running = workers.map((row, n) => ({ ...row, id: `worker_${n}`, workflow: "pr-triage-github", createdAt: "2026-10-09T00:00:00.000Z", cancelling: false, worker: true }));
      return { deployments: [...listeners, ...running] } as T;
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
      if (unconnected.includes((body as { entry: string }).entry)) throw new ApiError(409, "source_not_connected", "Connect it first.");
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
    if (method === "DELETE" && url.pathname.includes("/tarballs/")) {
      tarballs.delete(decodeURIComponent(path.split("/").at(-1) ?? ""));
      return { commit: "c" } as T;
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
  return { transport, fetchRaw: raw as typeof fetch, assets, tarballs, deployments, pins, requests, deployed, workers };
}

function puts(requests: string[]): string[] {
  return requests.filter((line) => line.startsWith("PUT ")).map((line) => decodeURIComponent(line.split("/").at(-1) ?? ""));
}

describe("ensureWorkflows", () => {
  test("publishes the tool before the workflows to one corbits registry and deploys each workflow pinned to its version", async () => {
    const hub = fakeHub();
    expect(await ensureWorkflows(hub.transport, "t", BOTH, MISSING, hub.fetchRaw)).toEqual(["pr-triage-github", "pr-triage-bitbucket-datacenter", "pr-triage-historical"]);

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
        definitionAssetId: workflowAsset("pr-triage-github"),
        pin: "@corbits/pr-triage-github-workflow@0.1.0-sha-aaaaaaaa",
        entry: "./pr-triage-github.mjs",
        sourceOfferingIds: ["mof_1"],
        defaultSourceOfferingId: "mof_1",
      },
      {
        registryAssetId: registryId,
        definitionAssetId: workflowAsset("pr-triage-bitbucket-datacenter"),
        pin: "@corbits/pr-triage-bitbucket-datacenter-workflow@0.1.0-sha-cccccccc",
        entry: "./pr-triage-bitbucket-datacenter.mjs",
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
    await ensureWorkflows(hub.transport, "t", BOTH, MISSING, hub.fetchRaw);
    hub.requests.length = 0;
    expect(await ensureWorkflows(hub.transport, "t", BOTH, MISSING, hub.fetchRaw)).toEqual([]);
    expect(puts(hub.requests)).toEqual([]);

    // A converge published this build, then its deploy failed: the live deployment still runs the older version.
    hub.pins.set("run_1", "@corbits/pr-triage-github-workflow@0.1.0-sha-00000000");
    expect(await ensureWorkflows(hub.transport, "t", BOTH, MISSING, hub.fetchRaw)).toEqual(["pr-triage-github"]);
    expect(puts(hub.requests)).toEqual([]);
    expect(hub.deployments.map((row) => [row.id, row.status])).toEqual([
      ["run_1", "released"],
      ["run_2", "deployed"],
      ["run_3", "deployed"],
      ["run_4", "deployed"],
    ]);
  });

  test("deploys only the connected hosts' workflows, and skips one the hub reports is no longer connected", async () => {
    const github = fakeHub();
    expect(await ensureWorkflows(github.transport, "t", GITHUB, MISSING, github.fetchRaw)).toEqual(["pr-triage-github", "pr-triage-historical"]);

    const disconnected = fakeHub({}, ["./pr-triage-bitbucket-datacenter.mjs"]);
    expect(await ensureWorkflows(disconnected.transport, "t", BOTH, MISSING, disconnected.fetchRaw)).toEqual(["pr-triage-github", "pr-triage-historical"]);
  });

  test("refuses to republish a version whose bytes changed, before publishing or deploying anything", async () => {
    const hub = fakeHub({ [INDEX[3]!.filename]: "sha512-other" });
    await expect(ensureWorkflows(hub.transport, "t", BOTH, MISSING, hub.fetchRaw))
      .rejects.toThrow("@corbits/pr-triage-historical-workflow@0.1.0-sha-bbbbbbbb is already published with different contents; this build did not pack reproducibly.");
    expect(puts(hub.requests)).toEqual([]);
    expect(hub.deployed).toEqual([]);
  });

  test("before publishing, removes every tarball neither this build nor a live listener or worker pins", async () => {
    const hub = fakeHub();
    await ensureWorkflows(hub.transport, "t", BOTH, MISSING, hub.fetchRaw);
    hub.pins.set("run_1", "@corbits/pr-triage-github-workflow@0.1.0-sha-00000000");
    hub.workers.push({ package: { name: "@corbits/pr-triage-github-workflow", version: "0.1.0-sha-22222222" }, tools: [{ name: "@corbits/github-tool", version: "0.1.0" }] });
    hub.tarballs.set("@corbits-pr-triage-github-workflow-0.1.0-sha-00000000.tgz", "sha512-listener");
    hub.tarballs.set("@corbits-pr-triage-github-workflow-0.1.0-sha-22222222.tgz", "sha512-worker");
    hub.tarballs.set("@corbits-github-tool-0.1.0.tgz", "sha512-worker-tool");
    hub.tarballs.set("@corbits-pr-triage-github-workflow-0.1.0-sha-11111111.tgz", "sha512-old");
    hub.tarballs.set("@corbits-github-tool-0.0.9.tgz", "sha512-old-tool");
    hub.tarballs.delete(INDEX[1]!.filename);
    hub.requests.length = 0;

    expect(await ensureWorkflows(hub.transport, "t", BOTH, MISSING, hub.fetchRaw)).toEqual(["pr-triage-github"]);
    const changes = hub.requests.filter((line) => /^(DELETE|PUT) .*\/tarballs\//.test(line) || line.includes("workflow-deploy"));
    expect(changes.map((line) => decodeURIComponent(line))).toEqual([
      expect.stringMatching(/^DELETE .*\/@corbits-pr-triage-github-workflow-0\.1\.0-sha-11111111\.tgz$/),
      expect.stringMatching(/^DELETE .*\/@corbits-github-tool-0\.0\.9\.tgz$/),
      expect.stringMatching(/^PUT .*\/@corbits-pr-triage-github-workflow-0\.1\.0-sha-aaaaaaaa\.tgz$/),
      "POST /api/integrations/workflow-deploy/t",
    ]);
    expect([...hub.tarballs.keys()].sort()).toEqual([
      ...INDEX.map((entry) => entry.filename),
      "@corbits-pr-triage-github-workflow-0.1.0-sha-00000000.tgz",
      "@corbits-pr-triage-github-workflow-0.1.0-sha-22222222.tgz",
      "@corbits-github-tool-0.1.0.tgz",
    ].sort());
  });

  test("a host's code review deploys only while it is on, with an offering for each model it names", async () => {
    const models = [
      ...DECISION,
      { canonicalName: "claude-opus-5-5", offerings: [{ offeringId: "mof_opus", providerName: "anthropic" }] },
      { canonicalName: "claude-haiku-5-5", offerings: [{ offeringId: "mof_haiku", providerName: "anthropic" }] },
    ];
    const hub = fakeHub({}, [], models);
    expect(await ensureWorkflows(hub.transport, "t", { connected: ["github"], codeReview: ["github"], codeReviewProvider: "anthropic", prWorkflow: [] }, MISSING, hub.fetchRaw)).toEqual(["pr-triage-github", "pr-triage-historical", "pr-code-review-github"]);
    expect(hub.deployed.at(-1)).toMatchObject({ entry: "./pr-code-review-github.mjs", sourceOfferingIds: ["mof_opus", "mof_haiku"], defaultSourceOfferingId: "mof_opus" });

    expect(await ensureWorkflows(hub.transport, "t", { connected: ["github"], codeReview: ["github"], codeReviewProvider: "anthropic", prWorkflow: [] }, new Set(["code-review"]), hub.fetchRaw)).toEqual(["pr-code-review-github"]);
  });

  test("a host's PR workflow deploys while its provider's key is stored and code review has a place, whatever the repositories' switches", async () => {
    const models = [
      ...DECISION,
      { canonicalName: "claude-opus-5-5", offerings: [{ offeringId: "mof_opus", providerName: "anthropic" }] },
      { canonicalName: "claude-haiku-5-5", offerings: [{ offeringId: "mof_haiku", providerName: "anthropic" }] },
    ];
    const hub = fakeHub({}, [], models);
    expect(await ensureWorkflows(hub.transport, "t", { ...GITHUB, prWorkflow: ["github"] }, MISSING, hub.fetchRaw)).toEqual(["pr-triage-github", "pr-triage-historical", "pr-workflow-anthropic-github"]);
    expect(hub.deployed.at(-1)).toMatchObject({ entry: "./pr-workflow-github.mjs", sourceOfferingIds: ["mof_1", "mof_opus", "mof_haiku"], defaultSourceOfferingId: "mof_1" });

    // Unknown leaves it; once no repository's policy file needs it, it is released.
    await ensureWorkflows(hub.transport, "t", { ...GITHUB, prWorkflow: undefined }, MISSING, hub.fetchRaw);
    expect(hub.requests.filter((line) => line.startsWith("DELETE") && line.includes("/workflows/runs/"))).toEqual([]);
    await ensureWorkflows(hub.transport, "t", GITHUB, MISSING, hub.fetchRaw);
    expect(hub.requests.filter((line) => line.startsWith("DELETE") && line.includes("/workflows/runs/"))).toEqual(["DELETE /api/tenants/t/workflows/runs/run_3"]);
  });

  test("a replaced credential deploys the listeners and the PR workflow again at the same version, and leaves code review to its next launch", async () => {
    const models = [
      ...DECISION,
      { canonicalName: "claude-opus-5-5", offerings: [{ offeringId: "mof_opus", providerName: "anthropic" }] },
      { canonicalName: "claude-haiku-5-5", offerings: [{ offeringId: "mof_haiku", providerName: "anthropic" }] },
    ];
    const hub = fakeHub({}, [], models);
    const hosts = { ...GITHUB, codeReview: ["github"], prWorkflow: ["github"] } as const;
    await ensureWorkflows(hub.transport, "t", hosts, MISSING, hub.fetchRaw);
    expect(await ensureWorkflows(hub.transport, "t", hosts, CREDENTIAL_HOLDERS, hub.fetchRaw)).toEqual(["pr-triage-github", "pr-triage-historical", "pr-workflow-anthropic-github"]);
  });

  test("refuses to deploy a workflow whose model the workspace does not offer", async () => {
    const hub = fakeHub({}, [], []);
    await expect(ensureWorkflows(hub.transport, "t", GITHUB, MISSING, hub.fetchRaw)).rejects.toThrow("The workspace has no decision model. Save its key in Settings.");
    expect(hub.deployed).toEqual([]);
  });
});

describe("cancelsSuperseded", () => {
  test("pr-triage's superseded deployments are cancelled only right after a deploy; pr-triage-historical's on every converge", () => {
    expect([cancelsSuperseded("pr-triage-github", true), cancelsSuperseded("pr-triage-github", false)]).toEqual([true, false]);
    expect([cancelsSuperseded("pr-triage-historical", true), cancelsSuperseded("pr-triage-historical", false)]).toEqual([true, true]);
  });
});
