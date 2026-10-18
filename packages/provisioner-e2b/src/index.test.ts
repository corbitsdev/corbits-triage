// Runs against an in-memory E2B; a live run needs an E2B key and template (docs/provisioners/e2b.md).
import { describe, expect, test } from "bun:test";
import { describeProvisionerConformance } from "@corbits/provisioner-conformance";
import type { AdapterManifest } from "@intx/types";
import { createE2bSidecarProvisioner, tendE2bSidecars, type E2bApi, type E2bCommand, type E2bSandbox } from "./index.js";

const HUB_URL = "wss://hub.example/api/sidecars/ws";
const MANIFEST: AdapterManifest = [{ provider: "corbits-system-one", specifier: "file:///app/packages/adapter/src/index.ts", export: "adapter" }];

type Fake = E2bApi & { readonly sandboxes: Map<string, E2bSandbox & { readonly command: E2bCommand; extended: number }> };

/** With `lagging`, the listing is one call behind, as E2B's is up to a second behind its sandboxes. */
function fakeE2b({ lagging = false } = {}): Fake {
  const sandboxes: Fake["sandboxes"] = new Map();
  let shown: E2bSandbox[] = [];
  let next = 0;
  return {
    sandboxes,
    async list(metadata) {
      const current = [...sandboxes.values()];
      const listed = lagging ? shown : current;
      shown = current;
      return listed.filter((sandbox) => Object.entries(metadata).every(([key, value]) => sandbox.metadata[key] === value));
    },
    async create(metadata, command) {
      await Bun.sleep(1);
      next += 1;
      const sandboxId = `sbx_${String(next)}`;
      sandboxes.set(sandboxId, { sandboxId, metadata, command, extended: 0 });
      return sandboxId;
    },
    async extend(sandboxId) {
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox !== undefined) sandbox.extended += 1;
    },
    async kill(sandboxId) {
      sandboxes.delete(sandboxId);
    },
    async exists(sandboxId) {
      return sandboxes.has(sandboxId);
    },
  };
}

function subject(e2b = fakeE2b(), hubId = "hub_a") {
  return { e2b, provisioner: createE2bSidecarProvisioner({ e2b, hubId, adapterManifest: MANIFEST, hubWebSocketUrl: HUB_URL }) };
}

describeProvisionerConformance("e2b", async () => {
  const { e2b, provisioner } = subject(fakeE2b({ lagging: true }));
  function sandboxesOf(allocationId: string) {
    return [...e2b.sandboxes.values()].filter((sandbox) => sandbox.metadata["corbits_allocation"] === allocationId);
  }
  async function only(allocationId: string) {
    const [sandbox, ...rest] = sandboxesOf(allocationId);
    if (sandbox === undefined || rest.length > 0) throw new Error(`Expected one sandbox for ${allocationId}`);
    return sandbox;
  }
  return {
    provisioner,
    async live(allocationId) {
      return sandboxesOf(allocationId).map((sandbox) => ({
        generation: Number(sandbox.metadata["corbits_generation"]),
        sidecarId: sandbox.metadata["corbits_sidecar"] ?? "",
      }));
    },
    // Each sandbox is its own microVM with internet access; what the in-memory backend proves is one sandbox per sidecar.
    capabilityChecks: {
      async "isolation:workload"(allocationId) {
        await only(allocationId);
      },
      async "network:outbound"(allocationId) {
        await only(allocationId);
      },
    },
    async dispose() {},
  };
});

describe("e2b provisioner", () => {
  test("starts the stock sidecar with the hub's address, its token, the adapter manifest and a fresh credential key", async () => {
    const { e2b, provisioner } = subject();
    await provisioner.ensure({ allocationId: "sal_1", generation: 1, tenantId: "t", anchorRunId: "r", sidecarId: "sc_1", token: "tok_1", hubWebSocketUrl: "ws://127.0.0.1/ws" });
    await provisioner.ensure({ allocationId: "sal_2", generation: 1, tenantId: "t", anchorRunId: "r", sidecarId: "sc_2", token: "tok_2", hubWebSocketUrl: "ws://127.0.0.1/ws" });
    const [first, second] = [...e2b.sandboxes.values()].map((sandbox) => sandbox.command);
    expect(first?.cwd).toBe("/app/vendor/interchange");
    expect(first?.envs).toMatchObject({ HUB_WS_URL: HUB_URL, SIDECAR_ID: "sc_1", SIDECAR_TOKEN: "tok_1", SIDECAR_ADAPTER_MANIFEST: JSON.stringify(MANIFEST) });
    expect(first?.envs["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"]).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.envs["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"]).not.toBe(first?.envs["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"]);
  });

  test("tending kills this hub's inactive sandboxes, extends its active ones and leaves other hubs' and newer ones alone", async () => {
    const e2b = fakeE2b();
    const mine = subject(e2b, "hub_a").provisioner;
    const theirs = subject(e2b, "hub_b").provisioner;
    function ensure(provisioner: typeof mine, allocationId: string) {
      return provisioner.ensure({ allocationId, generation: 1, tenantId: "t", anchorRunId: "r", sidecarId: `sc_${allocationId}`, token: "tok", hubWebSocketUrl: HUB_URL });
    }
    for (const [provisioner, allocationId] of [[mine, "sal_live"], [mine, "sal_leaked"], [theirs, "sal_other"]] as const) await ensure(provisioner, allocationId);
    async function activeWhileOneStarts() {
      await ensure(mine, "sal_new");
      return new Set(["sal_live"]);
    }
    expect(await tendE2bSidecars({ e2b, hubId: "hub_a" }, activeWhileOneStarts)).toBe(1);
    const left = [...e2b.sandboxes.values()].map((sandbox) => [sandbox.metadata["corbits_allocation"], sandbox.extended]);
    expect(left).toEqual([["sal_live", 1], ["sal_other", 0], ["sal_new", 0]]);
  });
});
