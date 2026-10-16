import { expect, test } from "bun:test";
import type { EnsureSidecarRequest } from "@intx/hub-sessions";
import { createDriverProvisioner, type SidecarDriver, type SidecarHandle } from "./driver-provisioner.js";

/** A backend that outlives the provisioner, as a container daemon outlives a hub restart. */
function fakeBackend() {
  const live = new Map<string, SidecarHandle>();
  let starts = 0;
  const driver: SidecarDriver = {
    id: "fake",
    fingerprint: "fake:v1",
    capabilities: [],
    async start(launch, env) {
      starts += 1;
      expect(env.SIDECAR_TOKEN).toBe(launch.token);
      const handle = { allocationId: launch.allocationId, generation: launch.generation, sidecarId: launch.sidecarId, externalRef: `c${String(starts)}`, running: true };
      live.set(launch.allocationId, handle);
      return handle;
    },
    async stop(handle) {
      live.delete(handle.allocationId);
    },
    async find(allocationId) {
      return live.get(allocationId) ?? null;
    },
  };
  return { driver, live, starts: () => starts };
}

function request(generation: number, sidecarId = `sc_${String(generation)}`): EnsureSidecarRequest {
  return { allocationId: "sal_1", generation, sidecarId, tenantId: "tnt_1", anchorRunId: "run_1", token: "tok", hubWebSocketUrl: "ws://hub" };
}

test("an ensure older than the backend's generation is rejected, and a destroy fences a late ensure", async () => {
  const backend = fakeBackend();
  const { provisioner } = createDriverProvisioner(backend.driver, "key");

  expect(await provisioner.ensure(request(2))).toMatchObject({ kind: "accepted", externalRef: "c1" });
  expect(await provisioner.ensure(request(1))).toMatchObject({ kind: "rejected", code: "stale_generation" });
  expect(await provisioner.destroy({ allocationId: "sal_1", generation: 2, sidecarId: "sc_2" })).toEqual({ kind: "destroyed" });
  expect(await provisioner.ensure(request(2))).toMatchObject({ kind: "rejected", code: "generation_destroyed" });
  expect(backend.live.size).toBe(0);
});

test("after a restart, ensure adopts the running capacity and destroy finds it by allocation id", async () => {
  const backend = fakeBackend();
  await createDriverProvisioner(backend.driver, "key").provisioner.ensure(request(1));

  const { provisioner } = createDriverProvisioner(backend.driver, "key");
  expect(await provisioner.ensure(request(1))).toMatchObject({ kind: "accepted", externalRef: "c1" });
  expect(await provisioner.ensure(request(0))).toMatchObject({ kind: "rejected", code: "stale_generation" });
  expect(backend.starts()).toBe(1);
  await provisioner.destroy({ allocationId: "sal_1", generation: 1, sidecarId: "sc_1" });
  expect(backend.live.size).toBe(0);
});

test("a delayed destroy of a replaced identity leaves the replacement running", async () => {
  const backend = fakeBackend();
  const { provisioner } = createDriverProvisioner(backend.driver, "key");
  await provisioner.ensure(request(3, "sc_old"));
  await provisioner.destroy({ allocationId: "sal_1", generation: 3, sidecarId: "sc_old" });
  await provisioner.ensure(request(3, "sc_new"));

  await provisioner.destroy({ allocationId: "sal_1", generation: 3, sidecarId: "sc_old" });

  expect(backend.live.get("sal_1")?.sidecarId).toBe("sc_new");
});
