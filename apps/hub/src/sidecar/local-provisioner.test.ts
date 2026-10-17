import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EnsureSidecarRequest } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import { CAPACITY_UNAVAILABLE, SIDECAR_BYTES } from "./host-capacity.js";
import { createLocalProcessSidecarProvisioner } from "./local-provisioner.js";
import type { LocalSidecarManifest } from "./manifest-store.js";

const HUB_ADAPTERS: AdapterManifest = [
  { provider: "corbits-system-one", specifier: "@corbits/system-one", export: "createSystemOneAdapterFactory" },
];

const RECORD_WITHOUT_ADAPTERS: LocalSidecarManifest = {
  allocationId: "alloc_1",
  generation: 1,
  sidecarId: "sc_1",
  tenantId: "tnt_1",
  anchorRunId: "run_1",
  hubWebSocketUrl: "ws://hub",
  dataDir: "/data/alloc_1",
  token: "token",
};

test("restore launches a record without adapterManifest with the hub's adapters", async () => {
  const spawned: EnsureSidecarRequest[] = [];
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-provisioner-"));
  const local = createLocalProcessSidecarProvisioner({
    dataRoot,
    capacity: { freeBytes: async () => undefined },
    adapterManifest: HUB_ADAPTERS,
    spawnSidecar: function spawnSidecar({ request }) {
      spawned.push(request);
      return { pid: 1, exited: new Promise<number>(function never() {}), kill() {} };
    },
    manifests: {
      readAll: async () => [RECORD_WITHOUT_ADAPTERS],
      write: async () => {},
      readDataDir: async () => null,
      remove: async () => {},
    },
    log: () => {},
  });

  try {
    await local.restore(async () => true);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }

  expect(spawned.map((request) => request.adapterManifest)).toEqual([HUB_ADAPTERS]);
});

test("restore removes a data dir no manifest names and keeps the ones that are named", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-provisioner-"));
  const named = path.join(dataRoot, "sal_1-Ab12Cd");
  const orphan = path.join(dataRoot, "sal_2-Ef34Gh");
  await fs.mkdir(named);
  await fs.mkdir(orphan);
  const local = createLocalProcessSidecarProvisioner({
    dataRoot,
    capacity: { freeBytes: async () => undefined },
    adapterManifest: HUB_ADAPTERS,
    spawnSidecar: function spawnSidecar() {
      throw new Error("restore has nothing to respawn");
    },
    manifests: {
      readAll: async () => [],
      write: async () => {},
      readDataDir: async (allocationId) => (allocationId === "sal_1" ? named : null),
      remove: async () => {},
    },
    log: () => {},
  });

  try {
    await local.restore(async () => true);
    expect((await fs.readdir(dataRoot)).sort()).toEqual(["sal_1-Ab12Cd"]);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});

function request(allocationId: string): EnsureSidecarRequest {
  return { ...RECORD_WITHOUT_ADAPTERS, allocationId, sidecarId: `sc_${allocationId}` };
}

test("ensures side by side count each other's sidecars until each connects or exits, and a decline spawns nothing", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-provisioner-"));
  const exits = new Map<string, () => void>();
  const local = createLocalProcessSidecarProvisioner({
    dataRoot,
    capacity: { freeBytes: async () => 2 * SIDECAR_BYTES },
    adapterManifest: HUB_ADAPTERS,
    spawnSidecar: function spawnSidecar({ request: spawned }) {
      const exited = new Promise<number>(function onExit(resolve) {
        exits.set(spawned.allocationId, () => resolve(0));
      });
      return { pid: 1, exited, kill() {} };
    },
    manifests: {
      readAll: async () => [],
      write: async () => {},
      readDataDir: async () => null,
      remove: async () => {},
    },
    log: () => {},
  });

  try {
    const burst = await Promise.all(["a", "b", "c"].map((id) => local.provisioner.ensure(request(id))));
    const declined = burst.filter((result) => result.kind === "rejected");
    expect(declined).toEqual([expect.objectContaining({ code: CAPACITY_UNAVAILABLE, retryable: true })]);
    const [first, second] = [...exits.keys()];
    expect((await fs.readdir(dataRoot)).length).toBe(2);

    local.connected({ allocationId: first!, generation: 1 });
    expect((await local.provisioner.ensure(request("d"))).kind).toBe("accepted");
    expect((await local.provisioner.ensure(request("e"))).kind).toBe("rejected");
    exits.get(second!)!();
    await Bun.sleep(0);
    expect((await local.provisioner.ensure(request("e"))).kind).toBe("accepted");
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
