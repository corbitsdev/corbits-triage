// The conformance suite and the sweep against real Fly Machines from the pushed sidecar image. It creates machines,
// so it is not part of `bun run test`; the token and app arrive on standard input:
// printf '{"token":"%s","app":"%s"}' "$FLY_API_TOKEN" "$FLY_APP" | bun --conditions=intx-src test ./packages/provisioner-fly/proof/live.ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { type } from "arktype";
import { describeProvisionerConformance } from "@corbits/provisioner-conformance";
import { connectFlyMachines, createFlySidecarProvisioner, flySidecarImage, sweepFlySidecars, type FlyMachine } from "../src/index.js";

setDefaultTimeout(5 * 60_000);

const Input = type({ token: "string > 0", app: "string > 0", "region?": "string > 0" });
const { token, app, region } = Input.assert(JSON.parse(await Bun.stdin.text()));
const machines = connectFlyMachines({ token, app });
const HUB_URL = "wss://hub.invalid/api/sidecars/ws";
const BOOT_WAIT_MS = 60_000;
/** Assumed: how far Fly's listing may be behind its machines. */
const LISTING_LAG_MS = 2_000;

async function noneActive(): Promise<ReadonlySet<string>> {
  return new Set();
}

/** A provisioner over a hub id of its own, so each starts from an empty backend. */
function subject() {
  const sidecars = { machines, hubId: `proof${randomBytes(4).toString("hex")}` };
  const provisioner = createFlySidecarProvisioner({
    ...sidecars,
    image: flySidecarImage(app),
    ...(region !== undefined && { region }),
    adapterManifest: [],
    hubWebSocketUrl: HUB_URL,
  });

  /** Listed for its labels, then read by id, since the listing lags. */
  async function present(allocationId: string) {
    await Bun.sleep(LISTING_LAG_MS);
    const listed = await machines.list({ corbits_hub: sidecars.hubId, corbits_allocation: allocationId });
    const current = await Promise.all(listed.map((machine) => machines.get(machine.id)));
    return current.filter((machine): machine is FlyMachine => machine !== undefined && machine.state !== "destroyed" && machine.state !== "destroying");
  }
  async function live(allocationId: string) {
    return (await present(allocationId)).map((machine) => ({
      generation: Number(machine.metadata["corbits_generation"]),
      sidecarId: machine.metadata["corbits_sidecar"] ?? "",
    }));
  }
  /** The allocation's one machine boots the image and keeps running, which it does only with a sidecar in it. */
  async function running(allocationId: string): Promise<void> {
    const found = await present(allocationId);
    const [only] = found;
    if (found.length !== 1 || only === undefined) throw new Error(`Expected one machine for ${allocationId}, found ${String(found.length)}`);
    const deadline = Date.now() + BOOT_WAIT_MS;
    let state = only.state;
    while (state !== "started") {
      if (Date.now() > deadline) throw new Error(`Machine ${only.id} is ${state} after ${String(BOOT_WAIT_MS)} ms`);
      await Bun.sleep(1_000);
      state = (await machines.get(only.id))?.state ?? "gone";
    }
  }
  async function dispose(): Promise<void> {
    await sweepFlySidecars(sidecars, noneActive);
  }
  return { sidecars, provisioner, live, capabilityChecks: { "isolation:workload": running, "network:outbound": running }, dispose };
}

describeProvisionerConformance("fly (live)", async () => subject());

test("the sweep destroys an unheld machine and keeps a held one", async () => {
  const { sidecars, provisioner, live } = subject();
  async function ensure(allocationId: string): Promise<void> {
    const result = await provisioner.ensure({ allocationId, generation: 1, tenantId: "t", anchorRunId: "r", sidecarId: `sc_${allocationId}`, token: "tok", hubWebSocketUrl: HUB_URL });
    if (result.kind !== "accepted") throw new Error(`ensure ${allocationId}: ${result.message}`);
  }
  async function heldOnly(): Promise<ReadonlySet<string>> {
    return new Set(["sal_held"]);
  }
  await ensure("sal_held");
  await ensure("sal_leaked");
  await Bun.sleep(LISTING_LAG_MS);
  expect(await sweepFlySidecars(sidecars, heldOnly)).toBe(1);
  expect(await live("sal_held")).toHaveLength(1);
  expect(await live("sal_leaked")).toHaveLength(0);
  await sweepFlySidecars(sidecars, noneActive);
  expect(await live("sal_held")).toHaveLength(0);
});
