// Runs against the local Docker daemon, found as the docker CLI finds it; skipped when none answers.
import { describe, test } from "bun:test";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { type } from "arktype";
import { describeProvisionerConformance } from "@corbits/provisioner-conformance";
import { connectDocker, createDockerSidecarProvisioner, findDockerHost, sweepDockerSidecars, type DockerEngine } from "./index.js";

const IMAGE = "oven/bun:1.4";
const GiB = 1024 ** 3;

const Listed = type({ Id: "string", Labels: { "corbits.generation": "string.integer.parse", "corbits.sidecar": "string" } });
const Inspected = type({
  HostConfig: { NetworkMode: "string", PidMode: "string", Privileged: "boolean" },
  Mounts: type({ Source: "string", Destination: "string" }).array(),
});

async function localDaemon(): Promise<DockerEngine | string> {
  const host = await findDockerHost({ home: os.homedir() });
  if (host === undefined) return "no Docker daemon found";
  try {
    const engine = connectDocker(host);
    await engine.request("GET", "/_ping", { timeoutMs: 2_000 });
    return engine;
  } catch (error) {
    return `Docker at ${host} does not answer: ${String(error)}`;
  }
}

/** The daemon with its reported memory replaced, so capacity does not depend on the machine. */
function withMemory(engine: DockerEngine, memTotal: number): DockerEngine {
  return {
    host: engine.host,
    async request(method, path, opts) {
      return path === "/info" ? { MemTotal: memTotal } : engine.request(method, path, opts);
    },
  };
}

const daemon = await localDaemon();

if (typeof daemon === "string") {
  describe.skip(`docker provisioner (${daemon})`, () => {
    test("conformance", () => {});
  });
} else {
  await Bun.$`docker -H ${daemon.host} pull --quiet ${IMAGE}`.quiet();
  const engine = daemon;

  function subject() {
    const hubId = `test${randomBytes(4).toString("hex")}`;
    const provisioner = createDockerSidecarProvisioner({ engine: withMemory(engine, 64 * GiB), hubId, daemonId: "test", image: IMAGE, adapterManifest: [] });

    async function containers(allocationId?: string) {
      const labels = [`corbits.hub=${hubId}`, ...(allocationId === undefined ? [] : [`corbits.allocation=${allocationId}`])];
      const filters = encodeURIComponent(JSON.stringify({ label: labels }));
      return Listed.array().assert(await engine.request("GET", `/containers/json?all=true&filters=${filters}`));
    }

    async function inspectOnly(allocationId: string) {
      const [only, ...rest] = await containers(allocationId);
      if (only === undefined || rest.length > 0) throw new Error(`Expected one container for ${allocationId}`);
      return Inspected.assert(await engine.request("GET", `/containers/${only.Id}/json`));
    }

    async function dispose() {
      await sweepDockerSidecars({ engine, hubId }, new Set());
    }

    return { provisioner, containers, inspectOnly, dispose };
  }

  describeProvisionerConformance("docker", async () => {
    const { provisioner, containers, inspectOnly, dispose } = subject();
    return {
      provisioner,
      async live(allocationId) {
        return (await containers(allocationId)).map((container) => ({
          generation: container.Labels["corbits.generation"],
          sidecarId: container.Labels["corbits.sidecar"],
        }));
      },
      capabilityChecks: {
        async "isolation:workload"(allocationId) {
          const { HostConfig, Mounts } = await inspectOnly(allocationId);
          if (HostConfig.Privileged || HostConfig.PidMode === "host" || HostConfig.NetworkMode === "host") {
            throw new Error("The sidecar shares the host's processes or network");
          }
          if (Mounts.some((mount) => mount.Source.endsWith("docker.sock"))) throw new Error("The sidecar can reach the Docker daemon");
        },
        async "network:outbound"(allocationId) {
          const { HostConfig } = await inspectOnly(allocationId);
          if (HostConfig.NetworkMode === "none") throw new Error("The sidecar has no network");
        },
      },
      dispose,
    };
  });
}
