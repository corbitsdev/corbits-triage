import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorText } from "@corbits/common";
import type { EnsureSidecarRequest } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import { SIDECAR_BYTES } from "./host-capacity.js";
import { createLocalProcessSidecarProvisioner } from "./local-provisioner.js";
import { createLocalSidecarManifestStore } from "./manifest-store.js";

const HUB_ADAPTERS: AdapterManifest = [
  { provider: "corbits-system-one", specifier: "@corbits/system-one", export: "createSystemOneAdapterFactory" },
];
async function allOpen(ids: readonly string[]): Promise<ReadonlySet<string>> {
  return new Set(ids);
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function request(allocationId: string, generation = 1): EnsureSidecarRequest {
  return {
    allocationId,
    generation,
    tenantId: "tnt_1",
    anchorRunId: `run_${allocationId}`,
    sidecarId: `sc_${allocationId}`,
    token: `token_${allocationId}`,
    hubWebSocketUrl: "ws://hub",
  };
}

async function setup({ maxSidecars = 4, freeBytes = async () => undefined }: { maxSidecars?: number; freeBytes?: () => Promise<number | undefined> } = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-provisioner-"));
  roots.push(dataRoot);
  const spawned: { sidecarId: string; token: string; dataDir: string; adapterManifest: AdapterManifest }[] = [];
  const crashes = new Map<string, () => void>();
  const reported: { sidecarId: string; options: unknown }[] = [];
  const manifests = createLocalSidecarManifestStore({ dataRoot, log: () => {} });
  const retired = Promise.withResolvers<void>();
  const retireFailed = Promise.withResolvers<void>();
  const connected = new Set<string>();
  const records = { stillOpen: allOpen, isConnected: (sidecarId: string) => connected.has(sidecarId) };
  function create() {
    return createLocalProcessSidecarProvisioner({
      dataRoot,
      capacity: { freeBytes },
      adapterManifest: HUB_ADAPTERS,
      maxSidecars,
      spawnSidecar: function spawnSidecar({ sidecarId, token, dataDir, adapterManifest }) {
        spawned.push({ sidecarId, token, dataDir, adapterManifest });
        const exit = Promise.withResolvers<{ code: number | null; signal: string | null }>();
        crashes.set(sidecarId, () => exit.resolve({ code: 1, signal: null }));
        return {
          pid: spawned.length,
          exited: exit.promise,
          kill(signal) {
            exit.resolve({ code: null, signal });
          },
        };
      },
      manifests,
      log(entry) {
        if (entry["msg"] === "local_sidecar_retired") retired.resolve();
        if (entry["msg"] === "local_sidecar_retire_failed") retireFailed.resolve();
      },
    });
  }
  function attach(local: ReturnType<typeof create>, fail?: string) {
    local.provisioner.attach?.({
      async sidecarStopped(sidecarId, options) {
        reported.push({ sidecarId, options });
        if (sidecarId === fail) throw new Error("database unavailable");
        return { kind: "retired" };
      },
    });
  }
  async function started(fail?: string) {
    const local = create();
    attach(local, fail);
    await local.boot(records);
    return local;
  }
  return { dataRoot, manifests, spawned, crashes, reported, connected, records, retired: retired.promise, retireFailed: retireFailed.promise, create, attach, started };
}

test("a local sidecar does not name its own connect timeout", async () => {
  const { create } = await setup();
  expect(create().provisioner.connectTimeoutMs).toBeUndefined();
});

test("each allocation starts its own sidecar, and destroying it stops the process and removes its files", async () => {
  const { dataRoot, manifests, spawned, started } = await setup();
  const local = await started();

  expect(await local.provisioner.ensure(request("a"))).toEqual({ kind: "accepted", externalRef: "1" });
  expect(await local.provisioner.ensure(request("b"))).toEqual({ kind: "accepted", externalRef: "2" });
  expect(spawned.map(({ sidecarId, token, adapterManifest }) => ({ sidecarId, token, adapterManifest }))).toEqual([
    { sidecarId: "sc_a", token: "token_a", adapterManifest: HUB_ADAPTERS },
    { sidecarId: "sc_b", token: "token_b", adapterManifest: HUB_ADAPTERS },
  ]);
  expect(new Set(spawned.map(({ dataDir }) => dataDir)).size).toBe(2);

  expect(await local.provisioner.destroy({ allocationId: "a", generation: 2, sidecarId: "sc_a" })).toEqual({ kind: "destroyed", cleanup: "confirmed" });
  expect(await manifests.listed()).toEqual(["sc_b"]);
  expect(await fs.readdir(dataRoot)).not.toContain(path.basename(spawned[0]!.dataDir));

  await local.shutdown();
});

test("past the cap an ensure is refused for capacity and retried, and the slot a destroy frees takes it", async () => {
  const { spawned, started } = await setup({ maxSidecars: 2 });
  const local = await started();

  const placed = await Promise.all([local.provisioner.ensure(request("a")), local.provisioner.ensure(request("b")), local.provisioner.ensure(request("c"))]);
  expect(placed.map((result) => result.kind)).toEqual(["accepted", "accepted", "rejected"]);
  expect(placed[2]).toMatchObject({ code: "capacity_unavailable", retryable: true });
  expect(spawned).toHaveLength(2);

  await local.provisioner.destroy({ allocationId: "a", generation: 2, sidecarId: "sc_a" });
  expect((await local.provisioner.ensure(request("c", 2))).kind).toBe("accepted");

  await local.shutdown();
});

test("a sidecar keeps its memory reserved until the hub holds its connection, a probe's too, and ensures side by side each count the other", async () => {
  const { connected, started } = await setup({ freeBytes: async () => SIDECAR_BYTES * 1.5 });
  const local = await started();

  const sideBySide = await Promise.all([local.provisioner.ensure(request("probe")), local.provisioner.ensure(request("b"))]);
  expect(sideBySide.map((result) => result.kind)).toEqual(["accepted", "rejected"]);
  expect(await local.provisioner.ensure(request("b", 2))).toMatchObject({ kind: "rejected", code: "capacity_unavailable", retryable: true });
  connected.add("sc_probe");
  expect((await local.provisioner.ensure(request("b", 3))).kind).toBe("accepted");

  await local.shutdown();
});

test("a sidecar that exits on its own is retired at once, freeing its slot and its files; one a destroy stopped is not", async () => {
  const { manifests, crashes, reported, retired, started } = await setup({ maxSidecars: 1 });
  const local = await started();

  await local.provisioner.ensure(request("a"));
  await local.provisioner.destroy({ allocationId: "a", generation: 2, sidecarId: "sc_a" });
  await local.provisioner.ensure(request("b"));
  crashes.get("sc_b")!();
  await retired;

  expect(reported).toEqual([{ sidecarId: "sc_b", options: { endReconnectWindow: true } }]);
  expect(await manifests.listed()).toEqual([]);
  expect((await local.provisioner.ensure(request("c"))).kind).toBe("accepted");

  await local.shutdown();
});

test("a sidecar whose retirement fails after it exits keeps its manifest for the next boot, and frees its slot", async () => {
  const { manifests, crashes, retireFailed, started } = await setup({ maxSidecars: 1 });
  const local = await started("sc_a");

  await local.provisioner.ensure(request("a"));
  crashes.get("sc_a")!();
  await retireFailed;

  expect(await manifests.listed()).toEqual(["sc_a"]);
  expect((await local.provisioner.ensure(request("b"))).kind).toBe("accepted");

  await local.shutdown();
});

test("boot retires every sidecar earlier boots started, from either layout, and removes their files; one it cannot retire fails boot and stays", async () => {
  const { dataRoot, manifests, reported, records, create, attach, started } = await setup();
  const earlier = await started();
  await earlier.provisioner.ensure(request("a"));
  await earlier.provisioner.ensure(request("b"));
  await earlier.shutdown();
  await fs.writeFile(path.join(dataRoot, "sidecar.json"), JSON.stringify({ sidecarId: "sc_shared", token: "sealed" }));
  await fs.mkdir(path.join(dataRoot, "sidecar"));

  const failing = create();
  attach(failing, "sc_b");
  const outcomes = await Promise.allSettled([failing.provisioner.ensure(request("c")), failing.boot(records)]);
  expect(outcomes.map((outcome) => outcome.status === "rejected" && errorText(outcome.reason))).toEqual(["database unavailable", "database unavailable"]);
  expect((await manifests.listed()).sort()).toEqual(["sc_a", "sc_b", "sc_shared"]);

  reported.length = 0;
  await started();
  expect(reported.map(({ sidecarId }) => sidecarId).sort()).toEqual(["sc_a", "sc_b", "sc_shared"]);
  expect(reported.every(({ options }) => (options as { endReconnectWindow: boolean }).endReconnectWindow)).toBe(true);
  expect(await fs.readdir(dataRoot)).toEqual([]);
});
