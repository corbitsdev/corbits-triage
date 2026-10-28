import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeProvisionerConformance } from "@corbits/provisioner-test";
import { createLocalProcessSidecarProvisioner } from "./local-provisioner.js";
import { createLocalSidecarManifestStore } from "./manifest-store.js";

type FakeProcess = {
  readonly sidecarId: string;
  running: boolean;
};

describeProvisionerConformance("local-process", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-provisioner-conformance-"));
  const processes: FakeProcess[] = [];
  const manifests = createLocalSidecarManifestStore({ dataRoot, log: () => {} });

  const local = createLocalProcessSidecarProvisioner({
    dataRoot,
    capacity: { freeBytes: async () => undefined },
    adapterManifest: [],
    maxSidecars: 4,
    spawnSidecar: function spawnSidecar({ sidecarId }) {
      const process: FakeProcess = { sidecarId, running: true };
      processes.push(process);
      const exit = Promise.withResolvers<{ code: number | null; signal: string | null }>();
      return {
        pid: processes.length,
        exited: exit.promise,
        kill(signal) {
          process.running = false;
          exit.resolve({ code: null, signal });
        },
      };
    },
    manifests,
    log: () => {},
  });
  local.provisioner.attach?.({ sidecarStopped: async () => ({ kind: "retired" }) });
  await local.boot({ stillOpen: async (ids) => new Set(ids), isConnected: () => true });

  return {
    provisioner: local.provisioner,
    async live(allocationId) {
      let manifest: { generation: number; sidecarId: string };
      try {
        manifest = JSON.parse(await fs.readFile(path.join(dataRoot, "manifests", `${allocationId}.json`), "utf8"));
      } catch {
        return [];
      }
      return processes
        .filter((process) => process.running && process.sidecarId === manifest.sidecarId)
        .map(({ sidecarId }) => ({ generation: manifest.generation, sidecarId }));
    },
    capabilityChecks: {},
    async dispose() {
      await local.shutdown();
      await fs.rm(dataRoot, { recursive: true, force: true });
    },
  };
});
