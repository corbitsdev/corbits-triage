import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeProvisionerConformance } from "@corbits/provisioner-test";
import { createLocalProcessSidecarProvisioner } from "./local-provisioner.js";
import type { LocalSidecarManifest } from "./manifest-store.js";

type FakeProcess = {
  readonly generation: number;
  readonly sidecarId: string;
  readonly allocationId: string;
  running: boolean;
};

describeProvisionerConformance("local-process", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-provisioner-conformance-"));
  const processes: FakeProcess[] = [];
  const manifests = new Map<string, LocalSidecarManifest>();

  const local = createLocalProcessSidecarProvisioner({
    dataRoot,
    capacity: { freeBytes: async () => undefined },
    adapterManifest: [],
    spawnSidecar: function spawnSidecar({ request }) {
      const process: FakeProcess = { ...request, running: true };
      processes.push(process);
      const exit = Promise.withResolvers<number>();
      return {
        pid: processes.length,
        exited: exit.promise,
        kill() {
          process.running = false;
          exit.resolve(0);
        },
      };
    },
    manifests: {
      readAll: async () => [...manifests.values()],
      async write(manifest) {
        manifests.set(manifest.allocationId, manifest);
      },
      readDataDir: async (allocationId) => manifests.get(allocationId)?.dataDir ?? null,
      async remove(allocationId) {
        manifests.delete(allocationId);
      },
    },
    log: () => {},
  });

  return {
    provisioner: local.provisioner,
    async live(allocationId) {
      return processes
        .filter((process) => process.running && process.allocationId === allocationId)
        .map(({ generation, sidecarId }) => ({ generation, sidecarId }));
    },
    capabilityChecks: {},
    async dispose() {
      await local.shutdown();
      await fs.rm(dataRoot, { recursive: true, force: true });
    },
  };
});
