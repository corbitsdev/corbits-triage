import { expect, test } from "bun:test";
import type { EnsureSidecarRequest } from "@intx/hub-sessions";
import { createDriverProvisioner, type SidecarDriver, type SidecarHandle, type SidecarUsage } from "./driver-provisioner.js";

/** A backend that outlives the provisioner, as a container daemon outlives a hub restart. */
function fakeBackend(maxAllocations?: number) {
  const live = new Map<string, SidecarHandle>();
  let starts = 0;
  const driver: SidecarDriver = {
    id: "fake",
    fingerprint: "fake:v1",
    capabilities: [],
    limits: maxAllocations === undefined ? {} : { maxAllocations },
    async start(launch, env) {
      starts += 1;
      expect(env.SIDECAR_TOKEN).toBe(launch.token);
      const { allocationId, generation, sidecarId, tenantId } = launch;
      const handle = { allocationId, generation, sidecarId, tenantId, externalRef: `c${String(starts)}`, running: true, startedAt: new Date(Date.now() - 1000) };
      live.set(launch.allocationId, handle);
      return handle;
    },
    async stop(handle) {
      live.delete(handle.allocationId);
    },
    async find(allocationId) {
      return live.get(allocationId) ?? null;
    },
    async list() {
      return [...live.values()];
    },
  };
  return { driver, live, starts: () => starts };
}

function seam(driver: SidecarDriver, usage: SidecarUsage[] = []) {
  return createDriverProvisioner(driver, { credentialEncryptionKey: "key", onUsage: (entry) => usage.push(entry) });
}

function request(generation: number, sidecarId = `sc_${String(generation)}`, allocationId = "sal_1"): EnsureSidecarRequest {
  return { allocationId, generation, sidecarId, tenantId: "tnt_1", anchorRunId: "run_1", token: "tok", hubWebSocketUrl: "ws://hub" };
}

test("an ensure older than the backend's generation is rejected, and a destroy fences a late ensure", async () => {
  const backend = fakeBackend();
  const { provisioner } = seam(backend.driver);

  expect(await provisioner.ensure(request(2))).toMatchObject({ kind: "accepted", externalRef: "c1" });
  expect(await provisioner.ensure(request(1))).toMatchObject({ kind: "rejected", code: "stale_generation" });
  expect(await provisioner.destroy({ allocationId: "sal_1", generation: 2, sidecarId: "sc_2" })).toEqual({ kind: "destroyed" });
  expect(await provisioner.ensure(request(2))).toMatchObject({ kind: "rejected", code: "generation_destroyed" });
  expect(backend.live.size).toBe(0);
});

test("after a restart, ensure adopts the running capacity and destroy finds it by allocation id", async () => {
  const backend = fakeBackend();
  await seam(backend.driver).provisioner.ensure(request(1));

  const { provisioner } = seam(backend.driver);
  expect(await provisioner.ensure(request(1))).toMatchObject({ kind: "accepted", externalRef: "c1" });
  expect(await provisioner.ensure(request(0))).toMatchObject({ kind: "rejected", code: "stale_generation" });
  expect(backend.starts()).toBe(1);
  await provisioner.destroy({ allocationId: "sal_1", generation: 1, sidecarId: "sc_1" });
  expect(backend.live.size).toBe(0);
});

test("a delayed destroy of a replaced identity leaves the replacement running", async () => {
  const backend = fakeBackend();
  const { provisioner } = seam(backend.driver);
  await provisioner.ensure(request(3, "sc_old"));
  await provisioner.destroy({ allocationId: "sal_1", generation: 3, sidecarId: "sc_old" });
  await provisioner.ensure(request(3, "sc_new"));

  await provisioner.destroy({ allocationId: "sal_1", generation: 3, sidecarId: "sc_old" });

  expect(backend.live.get("sal_1")?.sidecarId).toBe("sc_new");
});

test("a driver at its allocation limit refuses as retryable, and each stop reports the tenant's runtime", async () => {
  const backend = fakeBackend(1);
  const usage: SidecarUsage[] = [];
  const { provisioner } = seam(backend.driver, usage);
  await provisioner.ensure(request(1));

  expect(await provisioner.ensure(request(1, "sc_b", "sal_2"))).toMatchObject({ kind: "rejected", code: "capacity_full", retryable: true });
  await provisioner.destroy({ allocationId: "sal_1", generation: 1, sidecarId: "sc_1" });
  expect(await provisioner.ensure(request(1, "sc_b", "sal_2"))).toMatchObject({ kind: "accepted" });
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ driverId: "fake", tenantId: "tnt_1", allocationId: "sal_1" });
  expect(usage[0]?.runtimeMs).toBeGreaterThanOrEqual(1000);
});
