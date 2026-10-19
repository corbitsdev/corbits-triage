// The conformance suite against real Railway sandboxes, started by live.ts, which passes its inputs on standard input.
import { expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { type } from "arktype";
import { describeProvisionerConformance } from "@corbits/provisioner-conformance";
import { connectRailwaySandboxes, createRailwaySidecarProvisioner, sidecarTemplate, sweepRailwaySidecars, type RailwaySandboxes } from "../src/index.js";

setDefaultTimeout(10 * 60_000);

const Input = type({ token: "string > 0", environmentId: "string > 0", commit: "string > 0" });
const { token, environmentId, commit } = Input.assert(JSON.parse(await Bun.stdin.text()));
const sandboxes = connectRailwaySandboxes({ token, environmentId }, sidecarTemplate({ repository: "https://github.com/corbitsdev/corbits-triage", commit }));

/** The running sandboxes labelled for `hubId` and `allocationId`, read straight from Railway. */
async function labelled(railway: RailwaySandboxes, hubId: string, allocationId: string) {
  const found: Array<{ generation: number; sidecarId: string }> = [];
  for (const sandbox of await railway.list()) {
    if (sandbox.status !== "RUNNING") continue;
    const variables = await railway.readVariables(sandbox.id, ["CORBITS_HUB", "CORBITS_ALLOCATION", "CORBITS_GENERATION", "CORBITS_SIDECAR"]);
    if (variables?.["CORBITS_HUB"] !== hubId || variables["CORBITS_ALLOCATION"] !== allocationId) continue;
    found.push({ generation: Number(variables["CORBITS_GENERATION"]), sidecarId: variables["CORBITS_SIDECAR"] ?? "" });
  }
  return found;
}

async function noneActive(): Promise<ReadonlySet<string>> {
  return new Set();
}

describeProvisionerConformance("railway (live)", async () => {
  const hubId = `proof${randomBytes(4).toString("hex")}`;
  return {
    provisioner: createRailwaySidecarProvisioner({
      sandboxes,
      hubId,
      environmentId,
      adapterManifest: [],
      hubWebSocketUrl: "wss://hub.invalid/api/sidecars/ws",
    }),
    async live(allocationId) {
      return labelled(sandboxes, hubId, allocationId);
    },
    capabilityChecks: {
      async "isolation:workload"(allocationId) {
        const own = await labelled(sandboxes, hubId, allocationId);
        if (own.length !== 1) throw new Error(`Expected one sandbox for ${allocationId}, found ${String(own.length)}`);
      },
    },
    async dispose() {
      await sweepRailwaySidecars({ sandboxes, hubId }, noneActive);
    },
  };
});

test("the sweep destroys an unheld sandbox and keeps a held one", async () => {
  const hubId = `proof${randomBytes(4).toString("hex")}`;
  const provisioner = createRailwaySidecarProvisioner({ sandboxes, hubId, environmentId, adapterManifest: [], hubWebSocketUrl: "wss://hub.invalid/api/sidecars/ws" });
  async function ensure(allocationId: string): Promise<void> {
    const result = await provisioner.ensure({ allocationId, generation: 1, tenantId: "t", anchorRunId: "r", sidecarId: `sc_${allocationId}`, token: "tok", hubWebSocketUrl: "wss://hub.invalid" });
    if (result.kind !== "accepted") throw new Error(`ensure ${allocationId}: ${result.message}`);
  }
  async function heldOnly(): Promise<ReadonlySet<string>> {
    return new Set(["sal_held"]);
  }
  await ensure("sal_held");
  await ensure("sal_leaked");
  expect(await sweepRailwaySidecars({ sandboxes, hubId }, heldOnly)).toEqual({ removed: 1, unsettled: 0 });
  expect(await labelled(sandboxes, hubId, "sal_held")).toHaveLength(1);
  expect(await labelled(sandboxes, hubId, "sal_leaked")).toHaveLength(0);
  expect(await sweepRailwaySidecars({ sandboxes, hubId }, noneActive)).toEqual({ removed: 1, unsettled: 0 });
  expect(await labelled(sandboxes, hubId, "sal_held")).toHaveLength(0);
});
