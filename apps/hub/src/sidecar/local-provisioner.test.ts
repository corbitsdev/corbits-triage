import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import type { EnsureSidecarRequest } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import { SIDECAR_BYTES } from "./host-capacity.js";
import { createLocalProcessSidecarProvisioner } from "./local-provisioner.js";
import { createLocalSidecarManifestStore, type LocalSidecarHold, type LocalSidecarManifest } from "./manifest-store.js";

const HUB_ADAPTERS: AdapterManifest = [
  { provider: "corbits-system-one", specifier: "@corbits/system-one", export: "createSystemOneAdapterFactory" },
];

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function request(allocationId: string, generation = 1): EnsureSidecarRequest {
  return {
    allocationId,
    generation,
    tenantId: "tnt_1",
    anchorRunId: `run_${allocationId}`,
    sidecarId: `sc_${allocationId}`,
    token: `token_${allocationId}`,
    hubWebSocketUrl: "ws://hub",
  };
}

async function setup({ freeBytes = async () => undefined }: { freeBytes?: () => Promise<number | undefined> } = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-provisioner-"));
  roots.push(dataRoot);
  const spawned: { manifest: LocalSidecarManifest; adapterManifest: AdapterManifest }[] = [];
  const logs: Record<string, unknown>[] = [];
  const manifests = createLocalSidecarManifestStore({ dataRoot, cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)), log: () => {} });
  function create() {
    return createLocalProcessSidecarProvisioner({
      dataRoot,
      capacity: { freeBytes },
      adapterManifest: HUB_ADAPTERS,
      spawnSidecar: function spawnSidecar(args) {
        spawned.push(args);
        const exit = Promise.withResolvers<{ code: number | null; signal: string | null }>();
        return {
          pid: spawned.length,
          exited: exit.promise,
          kill(signal) {
            exit.resolve({ code: null, signal });
          },
        };
      },
      manifests,
      log: (entry) => logs.push(entry),
    });
  }
  return { dataRoot, manifests, spawned, logs, create };
}

test("every allocation joins the one sidecar, and destroying any of them leaves it running for the hub to undeploy", async () => {
  const { manifests, spawned, create } = await setup();
  const local = create();

  expect(await local.provisioner.ensure(request("a"))).toEqual({ kind: "accepted", externalRef: "1" });
  expect(await local.provisioner.ensure(request("b"))).toEqual({ kind: "accepted", externalRef: "1", sidecarId: "sc_a" });
  expect(await local.provisioner.ensure(request("b"))).toEqual({ kind: "accepted", externalRef: "1", sidecarId: "sc_a" });
  expect(spawned.map(({ manifest }) => manifest.sidecarId)).toEqual(["sc_a"]);

  expect(await local.provisioner.destroy({ allocationId: "a", generation: 2, sidecarId: "sc_a" })).toEqual({ kind: "destroyed", cleanup: "required" });
  // The hub never learned this ensure's outcome, so it names the identity it offered, under which nothing was deployed.
  expect(await local.provisioner.destroy({ allocationId: "c", generation: 1, sidecarId: "sc_c" })).toEqual({ kind: "destroyed", cleanup: "confirmed" });
  expect(await local.provisioner.ensure(request("a", 1))).toMatchObject({ kind: "rejected", code: "stale_generation" });
  expect(await manifests.readHolds()).toEqual([{ allocationId: "b", generation: 1, offeredSidecarId: "sc_b" }]);

  await local.shutdown();
});

test("a probe's start is the one start: its release keeps the sidecar, which the next deployment joins whatever memory is free", async () => {
  let free = SIDECAR_BYTES;
  const { spawned, create } = await setup({ freeBytes: async () => free });
  const local = create();

  expect((await local.provisioner.ensure(request("probe"))).kind).toBe("accepted");
  free = 0;
  expect(await local.provisioner.destroy({ allocationId: "probe", generation: 2, sidecarId: "sc_probe" })).toEqual({ kind: "destroyed", cleanup: "required" });
  expect(await local.provisioner.ensure(request("deployment"))).toEqual({ kind: "accepted", externalRef: "1", sidecarId: "sc_probe" });
  expect(spawned).toHaveLength(1);

  await local.shutdown();
});

function nothingElse(): Promise<boolean> {
  return Promise.resolve(false);
}

test("restore respawns the sidecar once for the holds still live and drops the rest", async () => {
  const { dataRoot, manifests, spawned, logs, create } = await setup();
  const stored: LocalSidecarManifest = { sidecarId: "sc_first", token: "token_first", hubWebSocketUrl: "ws://hub", dataDir: path.join(dataRoot, "sidecar") };
  const holds: LocalSidecarHold[] = [
    { allocationId: "listener", generation: 1, offeredSidecarId: "sc_first" },
    { allocationId: "manager", generation: 3, offeredSidecarId: "sc_manager" },
    { allocationId: "released", generation: 1, offeredSidecarId: "sc_released" },
  ];
  await manifests.write(stored);
  await manifests.writeHolds(holds);
  const local = create();

  const asked: string[] = [];
  async function isLive(hold: LocalSidecarHold & { sidecarId: string }): Promise<boolean> {
    asked.push(`${hold.allocationId}@${String(hold.generation)} on ${hold.sidecarId}`);
    return hold.allocationId !== "released";
  }
  await local.restore({ isLive, hasWork: nothingElse });

  expect(asked).toEqual(["listener@1 on sc_first", "manager@3 on sc_first", "released@1 on sc_first"]);
  expect(spawned).toEqual([{ manifest: stored, adapterManifest: HUB_ADAPTERS }]);
  expect(await manifests.readHolds()).toEqual(holds.slice(0, 2));
  expect(logs).toContainEqual(expect.objectContaining({ msg: "local_sidecar_respawned", sidecarId: "sc_first", holds: 2, dropped: 1 }));
  expect(await local.provisioner.ensure(request("next"))).toEqual({ kind: "accepted", externalRef: "1", sidecarId: "sc_first" });
  expect(spawned).toHaveLength(1);

  await local.shutdown();
});

test("restore with no live hold and no copy left to remove forgets the sidecar, and the next ensure starts one under its own identity", async () => {
  const { dataRoot, manifests, spawned, create } = await setup();
  const dataDir = path.join(dataRoot, "sidecar");
  await fs.mkdir(dataDir);
  await manifests.write({ sidecarId: "sc_first", token: "token_first", hubWebSocketUrl: "ws://hub", dataDir });
  await manifests.writeHolds([{ allocationId: "released", generation: 1, offeredSidecarId: "sc_first" }]);
  const local = create();

  await local.restore({ isLive: nothingElse, hasWork: nothingElse });

  expect(spawned).toEqual([]);
  expect(await manifests.read()).toBeNull();
  expect(await fs.readdir(dataRoot)).toEqual(["holds.json"]);
  expect(await local.provisioner.ensure(request("next"))).toEqual({ kind: "accepted", externalRef: "1" });
  expect(spawned.map(({ manifest }) => manifest.sidecarId)).toEqual(["sc_next"]);

  await local.shutdown();
});

test("restore brings the sidecar back while the hub still waits for it to remove a released copy", async () => {
  const { dataRoot, manifests, spawned, create } = await setup();
  const stored: LocalSidecarManifest = { sidecarId: "sc_first", token: "token_first", hubWebSocketUrl: "ws://hub", dataDir: path.join(dataRoot, "sidecar") };
  await manifests.write(stored);
  await manifests.writeHolds([]);
  const local = create();

  await local.restore({ isLive: nothingElse, hasWork: async (sidecarId) => sidecarId === "sc_first" });

  expect(spawned).toEqual([{ manifest: stored, adapterManifest: HUB_ADAPTERS }]);
  expect(await manifests.read()).toEqual(stored);

  await local.shutdown();
});

test("a late ensure for a destroyed identity, or another identity at a live generation, is refused", async () => {
  const { create } = await setup();
  const local = create();

  await local.provisioner.ensure(request("a"));
  await local.provisioner.destroy({ allocationId: "a", generation: 2, sidecarId: "sc_a" });
  expect(await local.provisioner.ensure({ ...request("a", 2), sidecarId: "sc_a" })).toMatchObject({ kind: "rejected", code: "generation_destroyed" });
  expect((await local.provisioner.ensure({ ...request("a", 2), sidecarId: "sc_a2" })).kind).toBe("accepted");
  expect(await local.provisioner.ensure({ ...request("a", 2), sidecarId: "sc_other" })).toMatchObject({ kind: "rejected", code: "sidecar_identity_conflict" });

  await local.shutdown();
});

test("the sidecar's exit is logged with how it ended", async () => {
  const { logs, create } = await setup();
  const local = create();

  await local.provisioner.ensure(request("a"));
  await local.shutdown();

  expect(logs).toContainEqual({ level: "info", msg: "local_sidecar_exited", sidecarId: "sc_a", pid: 1, code: null, signal: "SIGTERM" });
});

test("a destroy older than the allocation's hold leaves the live generation held", async () => {
  const { manifests, create } = await setup();
  const local = create();

  await local.provisioner.ensure(request("listener"));
  await local.provisioner.ensure(request("a", 2));
  expect(await local.provisioner.destroy({ allocationId: "a", generation: 1, sidecarId: "sc_listener" })).toEqual({ kind: "destroyed", cleanup: "required" });
  expect(await manifests.readHolds()).toContainEqual({ allocationId: "a", generation: 2, offeredSidecarId: "sc_a" });
  expect(await local.provisioner.ensure(request("a", 2))).toMatchObject({ kind: "accepted", sidecarId: "sc_listener" });

  await local.shutdown();
});

test("an unreadable holds file is removed and restore goes on without it", async () => {
  const { dataRoot, create } = await setup();
  await fs.writeFile(path.join(dataRoot, "holds.json"), "[{\"allocationId\":");
  const local = create();

  await local.restore({ isLive: nothingElse, hasWork: nothingElse });

  expect(await fs.readdir(dataRoot)).toEqual([]);

  await local.shutdown();
});

test("restore removes what a hub with one sidecar per allocation left, only when its manifests directory is there", async () => {
  const { dataRoot, logs, create } = await setup();
  await fs.mkdir(path.join(dataRoot, "sal_kept-Ab12Cd"));
  await create().restore({ isLive: nothingElse, hasWork: nothingElse });
  expect(await fs.readdir(dataRoot)).toContain("sal_kept-Ab12Cd");

  await fs.mkdir(path.join(dataRoot, "manifests"));
  await fs.writeFile(path.join(dataRoot, "manifests", "sal_old.json"), "{}");
  await fs.mkdir(path.join(dataRoot, "sidecar"));
  await create().restore({ isLive: nothingElse, hasWork: nothingElse });

  expect(await fs.readdir(dataRoot)).toEqual(["sidecar"]);
  expect(logs).toContainEqual({ level: "info", msg: "local_sidecar_legacy_layout_removed", removed: ["manifests", "sal_kept-Ab12Cd"] });
});
