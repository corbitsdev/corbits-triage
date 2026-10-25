// Started by e2b.ts, which passes its inputs on standard input.
import { expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { type } from "arktype";
import { Sandbox } from "e2b";
import { connectE2b, createE2bSidecarProvisioner, E2B_SIDECAR_TEMPLATE, tendE2bSidecars } from "@corbits/provisioner-e2b";
import { describeProvisionerConformance } from "@corbits/provisioner-test";

setDefaultTimeout(5 * 60_000);

/** E2B's listing is up to a second behind its sandboxes. */
const LISTING_LAG_MS = 2000;

const Input = type({ apiKey: "string > 0" });
const { apiKey } = Input.assert(JSON.parse(await Bun.stdin.text()));
const e2b = connectE2b({ apiKey, template: E2B_SIDECAR_TEMPLATE });

async function noneActive(): Promise<ReadonlySet<string>> {
  return new Set();
}

/** A provisioner over a hub id of its own, so each starts from an empty backend. */
function subject() {
  const sidecars = { e2b, hubId: `proof${randomBytes(4).toString("hex")}` };
  const provisioner = createE2bSidecarProvisioner({ ...sidecars, adapterManifest: [], hubWebSocketUrl: "wss://hub.invalid/api/sidecars/ws" });
  async function live(allocationId: string) {
    await Bun.sleep(LISTING_LAG_MS);
    return (await e2b.list({ corbits_hub: sidecars.hubId, corbits_allocation: allocationId })).map((sandbox) => ({
      generation: Number(sandbox.metadata["corbits_generation"]),
      sidecarId: sandbox.metadata["corbits_sidecar"]!,
    }));
  }
  async function one(allocationId: string): Promise<void> {
    if ((await live(allocationId)).length !== 1) throw new Error(`Expected one sandbox for ${allocationId}`);
  }
  async function dispose(): Promise<void> {
    await Bun.sleep(LISTING_LAG_MS);
    await tendE2bSidecars(sidecars, noneActive);
  }
  return { sidecars, provisioner, live, capabilityChecks: { "isolation:workload": one, "network:outbound": one }, dispose };
}

describeProvisionerConformance("e2b (live)", async () => subject());

test("tending extends a held sandbox and kills an unheld one", async () => {
  const { sidecars, provisioner, live } = subject();
  async function ensure(allocationId: string): Promise<string> {
    const result = await provisioner.ensure({ allocationId, generation: 1, tenantId: "t", anchorRunId: "r", sidecarId: `sc_${allocationId}`, token: "tok", hubWebSocketUrl: "wss://hub.invalid" });
    if (result.kind !== "accepted" || result.externalRef === undefined) throw new Error(`ensure ${allocationId}: ${JSON.stringify(result)}`);
    return result.externalRef;
  }
  async function endAt(sandboxId: string): Promise<number> {
    return (await Sandbox.getInfo(sandboxId, { apiKey })).endAt.getTime();
  }
  async function heldOnly(): Promise<ReadonlySet<string>> {
    return new Set(["sal_held"]);
  }
  const held = await ensure("sal_held");
  await ensure("sal_leaked");
  const before = await endAt(held);
  await Bun.sleep(LISTING_LAG_MS);
  expect(await tendE2bSidecars(sidecars, heldOnly)).toBe(1);
  expect(await endAt(held)).toBeGreaterThanOrEqual(before);
  expect(await live("sal_held")).toHaveLength(1);
  expect(await live("sal_leaked")).toHaveLength(0);
  expect(await tendE2bSidecars(sidecars, noneActive)).toBe(1);
  expect(await live("sal_held")).toHaveLength(0);
});
