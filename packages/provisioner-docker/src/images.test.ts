import { expect, test } from "bun:test";
import { DockerEngineError, type DockerEngine } from "./engine.js";
import { createDockerSidecarProvisioner } from "./index.js";

const PINNED = "ghcr.io/corbitsdev/corbits-triage-sidecar@sha256:new";
const REQUEST = { tenantId: "t", allocationId: "a", anchorRunId: "r", generation: 1, sidecarId: "s", token: "tok", hubWebSocketUrl: "ws://127.0.0.1:3000/api/sidecars/ws" };

/** A daemon without the sidecar image until a pull, whose progress is `progress`, brings it. */
function daemon(progress: unknown[]) {
  const calls: string[] = [];
  let pulled = false;
  const engine: DockerEngine = {
    host: "unix:///var/run/docker.sock",
    async request(method, path, opts) {
      const { pathname } = new URL(`http://docker${path}`);
      calls.push(`${method} ${pathname}${opts?.signal === undefined ? "" : " (cancellable)"}`);
      if (pathname === "/info") return { MemTotal: 64 * 1024 ** 3 };
      if (pathname === "/containers/json") return [];
      if (pathname === "/images/create") {
        pulled = !progress.some((line) => typeof line === "object" && line !== null && "error" in line);
        return progress;
      }
      if (pathname === "/containers/create") {
        if (!pulled) throw new DockerEngineError(404, "No such image");
        return { Id: "c1" };
      }
      return null;
    },
  };
  return { engine, calls };
}

function ensure(engine: DockerEngine, image: string) {
  return createDockerSidecarProvisioner({ engine, hubId: "hub", daemonId: "daemon", image, adapterManifest: [] }).ensure({ ...REQUEST, signal: new AbortController().signal });
}

test("the first sidecar on a daemon without the pinned image pulls it, uncancelled by the placement, then starts", async () => {
  const { engine, calls } = daemon([{ status: "Pulling" }, { status: "Downloaded newer image" }]);
  expect(await ensure(engine, PINNED)).toEqual({ kind: "accepted", externalRef: "c1" });
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /containers/create (cancellable)", "POST /images/create", "POST /containers/create (cancellable)", "POST /containers/c1/start (cancellable)"]);
});

test("a failed pull fails that sidecar with the image and the command to pull it, and a locally built image is never pulled", async () => {
  await expect(ensure(daemon([{ status: "Pulling" }, { error: "denied" }]).engine, PINNED)).rejects.toThrow(`Docker could not pull ${PINNED} (denied); pull it with docker pull ${PINNED}`);
  const local = daemon([]);
  await expect(ensure(local.engine, "corbits-triage-sidecar")).rejects.toThrow("No such image");
  expect(local.calls.filter((call) => call.startsWith("POST /images/create"))).toEqual([]);
});
