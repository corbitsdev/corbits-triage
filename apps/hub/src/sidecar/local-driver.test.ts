import { expect, test } from "bun:test";
import type { AdapterManifest } from "@intx/types";
import { createDriverProvisioner } from "./driver-provisioner.js";
import { createLocalProcessDriver } from "./local-driver.js";
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
  const spawned: string[] = [];
  const driver = createLocalProcessDriver({
    dataRoot: "/data",
    adapterManifest: HUB_ADAPTERS,
    spawnSidecar: function spawnSidecar(env) {
      spawned.push(env.SIDECAR_ADAPTER_MANIFEST);
      return { pid: 1, exited: new Promise<number>(function never() {}), kill() {} };
    },
    manifests: {
      readAll: async () => [RECORD_WITHOUT_ADAPTERS],
      write: async () => {},
      read: async () => RECORD_WITHOUT_ADAPTERS,
      remove: async () => {},
    },
    log: () => {},
  });

  await driver.restore(createDriverProvisioner(driver, "key"), async () => true, "key");

  expect(spawned).toEqual([JSON.stringify(HUB_ADAPTERS)]);
});
