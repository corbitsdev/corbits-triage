import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EnsureSidecarRequest } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import { createLocalProcessSidecarProvisioner } from "./local-provisioner.js";
import { createLocalSidecarManifestStore } from "./manifest-store.js";

const HUB_ADAPTERS: AdapterManifest = [
  { provider: "corbits-system-one", specifier: "@corbits/system-one", export: "createSystemOneAdapterFactory" },
];
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

async function started(maxSidecars: number) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-provisioner-"));
  roots.push(dataRoot);
  const spawned: string[] = [];
  const crashes = new Map<string, () => void>();
  const reported: { sidecarId: string; options: unknown }[] = [];
  const retired = Promise.withResolvers<void>();
  const manifests = createLocalSidecarManifestStore({ dataRoot, log: () => {} });
  const local = createLocalProcessSidecarProvisioner({
    dataRoot,
    capacity: { freeBytes: async () => undefined },
    adapterManifest: HUB_ADAPTERS,
    maxSidecars,
    spawnSidecar: function spawnSidecar({ sidecarId }) {
      spawned.push(sidecarId);
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
    },
  });
  local.provisioner.attach?.({
    async sidecarStopped(sidecarId, options) {
      reported.push({ sidecarId, options });
      return { kind: "retired" };
    },
  });
  await local.boot({ stillOpen: async (ids) => new Set(ids), isConnected: () => false });
  return { local, spawned, crashes, reported, retired: retired.promise, manifests };
}

test("past the cap an ensure is refused for capacity and retried, and the slot a destroy frees takes it", async () => {
  const { local, spawned } = await started(2);

  const placed = await Promise.all([local.provisioner.ensure(request("a")), local.provisioner.ensure(request("b")), local.provisioner.ensure(request("c"))]);
  expect(placed.map((result) => result.kind)).toEqual(["accepted", "accepted", "rejected"]);
  expect(placed[2]).toMatchObject({ code: "capacity_unavailable", retryable: true });
  expect(spawned).toHaveLength(2);

  await local.provisioner.destroy({ allocationId: "a", generation: 2, sidecarId: "sc_a" });
  expect((await local.provisioner.ensure(request("c", 2))).kind).toBe("accepted");

  await local.shutdown();
});

test("a sidecar that exits on its own is retired at once, freeing its slot and its files; one a destroy stopped is not", async () => {
  const { local, crashes, reported, retired, manifests } = await started(1);

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
