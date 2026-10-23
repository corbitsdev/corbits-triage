import { expect, test } from "bun:test";
import { type } from "arktype";
import { createDockerSidecarProvisioner, type DockerEngine } from "./index.js";

const Created = type({ Env: "string[]", HostConfig: { "ExtraHosts?": "string[]" } });

/** A daemon with room for sidecars that keeps each container create body. */
function recordingDaemon(created: unknown[]): DockerEngine {
  return {
    host: "tcp://203.0.113.10:2376",
    async request(method, path, opts) {
      const { pathname } = new URL(`http://docker${path}`);
      if (pathname === "/info") return { MemTotal: 64 * 1024 ** 3 };
      if (pathname === "/containers/json") return [];
      if (pathname === "/containers/create") {
        created.push(opts?.body);
        return { Id: `c${String(created.length)}` };
      }
      return null;
    },
  };
}

async function launch(hubWebSocketUrl: string | undefined) {
  const created: unknown[] = [];
  const provisioner = createDockerSidecarProvisioner({
    engine: recordingDaemon(created),
    hubId: "hub",
    daemonId: "daemon",
    image: "corbits-triage-sidecar",
    adapterManifest: [],
    ...(hubWebSocketUrl !== undefined && { hubWebSocketUrl }),
  });
  await provisioner.ensure({ tenantId: "t", allocationId: "a", anchorRunId: "r", generation: 1, sidecarId: "s", token: "tok", hubWebSocketUrl: "ws://127.0.0.1:3000/api/sidecars/ws" });
  const { Env, HostConfig } = Created.assert(created[0]);
  return { hubUrl: Env.find((line) => line.startsWith("HUB_WS_URL=")), extraHosts: HostConfig.ExtraHosts };
}

test("a container on another machine dials the hub's public address with no Docker host mapping", async () => {
  expect(await launch("wss://triage.example.com/api/sidecars/ws")).toEqual({ hubUrl: "HUB_WS_URL=wss://triage.example.com/api/sidecars/ws", extraHosts: undefined });
  expect(await launch(undefined)).toEqual({ hubUrl: "HUB_WS_URL=ws://host.docker.internal:3000/api/sidecars/ws", extraHosts: ["host.docker.internal:host-gateway"] });
});

test("a new image changes the binding, so the hub never reuses sidecars of the old one", () => {
  function fingerprint(image: string): string {
    return createDockerSidecarProvisioner({ engine: recordingDaemon([]), hubId: "hub", daemonId: "daemon", image, adapterManifest: [] }).bindingFingerprint;
  }
  expect(fingerprint("ghcr.io/corbitsdev/corbits-triage-sidecar@sha256:b")).not.toBe(fingerprint("ghcr.io/corbitsdev/corbits-triage-sidecar@sha256:a"));
});
