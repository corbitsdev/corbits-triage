import { expect, test } from "bun:test";
import type { EnsureSidecarRequest } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
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
  const local = createLocalProcessSidecarProvisioner({
    dataRoot: "/data",
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

  await local.restore(async () => true);

  expect(spawned.map((request) => request.adapterManifest)).toEqual([HUB_ADAPTERS]);
});
