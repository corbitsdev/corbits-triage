// Runs against an in-memory Machines API at the HTTP level; proof/live.ts runs the same suite against Fly.
import { describe, expect, test } from "bun:test";
import { describeProvisionerConformance } from "@corbits/provisioner-conformance";
import type { AdapterManifest } from "@intx/types";
import { connectFlyMachines, createFlySidecarProvisioner, sweepFlySidecars, type FlyMachineSpec } from "./index.js";

const TOKEN = "fly_test_token";
const APP = "corbits-sidecars";
const IMAGE = `registry.fly.io/${APP}:sidecar`;
const HUB_URL = "wss://hub.example/api/sidecars/ws";
const MANIFEST: AdapterManifest = [{ provider: "corbits-system-one", specifier: "file:///app/packages/adapter/src/index.ts", export: "adapter" }];

type FakeMachine = { id: string; state: string; region: string; config: FlyMachineSpec["config"] };

/**
 * The Machines API routes the provisioner calls, as Fly answers them. Its listing returns what the previous listing
 * saw, so a new machine is missing and a destroyed one still shown, as Fly's listing lags its machines.
 */
function fakeFly() {
  const machines = new Map<string, FakeMachine>();
  let shown: FakeMachine[] = [];
  let next = 0;

  function json(body: unknown, status = 200): Response {
    return Response.json(body, { status });
  }

  function notFound(): Response {
    return json({ error: "machine not found" }, 404);
  }

  async function handle(method: string, url: URL, body: unknown): Promise<Response> {
    const [, version, apps, app, collection, id, action] = url.pathname.split("/");
    if (version !== "v1" || apps !== "apps" || collection !== "machines") return notFound();
    if (app !== APP) return json({ error: "app not found" }, 404);
    if (method === "GET" && id === undefined) {
      const listed = shown.filter((machine) => machine.state !== "destroyed");
      shown = [...machines.values()].map((machine) => ({ ...machine }));
      const filters = [...url.searchParams].filter(([key]) => key.startsWith("metadata."));
      return json(listed.filter((machine) => filters.every(([key, value]) => machine.config.metadata[key.slice("metadata.".length)] === value)));
    }
    if (method === "POST" && id === undefined) {
      const { region, config } = body as FlyMachineSpec;
      if (typeof config?.image !== "string") return json({ error: "image is required" }, 400);
      await Bun.sleep(1);
      next += 1;
      const machine = { id: `e784${String(next).padStart(10, "0")}`, state: "started", region: region ?? "iad", config };
      machines.set(machine.id, machine);
      return json(machine);
    }
    const machine = id === undefined ? undefined : machines.get(id);
    if (machine === undefined) return notFound();
    if (method === "GET" && action === undefined) return json(machine);
    if (method === "DELETE" && action === undefined) {
      if (machine.state === "destroyed") return notFound();
      if (machine.state === "started" && url.searchParams.get("force") !== "true") return json({ error: "failed_precondition: machine still active" }, 412);
      machine.state = "destroying";
      return json({ ok: true });
    }
    if (method === "GET" && action === "wait" && url.searchParams.get("state") === "destroyed") {
      if (machine.state === "destroying") machine.state = "destroyed";
      return machine.state === "destroyed" ? json({ ok: true }) : json({ error: "deadline_exceeded" }, 408);
    }
    return notFound();
  }

  async function fetchFly(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    if (url.origin !== "https://api.machines.dev") throw new Error(`Unexpected request to ${url.href}`);
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return json({ error: "unauthorized" }, 401);
    return handle(init?.method ?? "GET", url, init?.body === undefined ? undefined : JSON.parse(String(init.body)));
  }

  /** The machines Fly holds, read without the listing's lag. */
  function present(): FakeMachine[] {
    return [...machines.values()].filter((machine) => machine.state !== "destroyed");
  }

  return { api: connectFlyMachines({ token: TOKEN, app: APP, fetch: fetchFly as typeof fetch }), present };
}

function subject(fly = fakeFly(), hubId = "hub_a") {
  const provisioner = createFlySidecarProvisioner({ machines: fly.api, hubId, image: IMAGE, region: "ord", adapterManifest: MANIFEST, hubWebSocketUrl: HUB_URL });
  return { fly, provisioner };
}

function ensureRequest(allocationId: string, sidecarId = `sc_${allocationId}`) {
  return { allocationId, generation: 1, tenantId: "t", anchorRunId: "r", sidecarId, token: `tok_${sidecarId}`, hubWebSocketUrl: "ws://127.0.0.1/ws" };
}

describeProvisionerConformance("fly", async () => {
  const { fly, provisioner } = subject();
  function machinesOf(allocationId: string) {
    return fly.present().filter((machine) => machine.config.metadata["corbits_allocation"] === allocationId);
  }
  async function only(allocationId: string) {
    const [machine, ...rest] = machinesOf(allocationId);
    if (machine === undefined || rest.length > 0) throw new Error(`Expected one machine for ${allocationId}`);
    return machine;
  }
  return {
    provisioner,
    async live(allocationId) {
      return machinesOf(allocationId).map((machine) => ({
        generation: Number(machine.config.metadata["corbits_generation"]),
        sidecarId: machine.config.metadata["corbits_sidecar"] ?? "",
      }));
    },
    // Each machine is its own Firecracker microVM with outbound network; what the fake proves is one machine per sidecar.
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

describe("fly provisioner", () => {
  test("starts the sidecar image with the hub's address, its token, the adapter manifest and a fresh credential key", async () => {
    const { fly, provisioner } = subject();
    await provisioner.ensure(ensureRequest("sal_1"));
    await provisioner.ensure(ensureRequest("sal_2"));
    const [first, second] = fly.present();
    expect(first).toMatchObject({ region: "ord", config: { image: IMAGE, restart: { policy: "no" }, auto_destroy: true } });
    expect(first?.config.metadata).toEqual({ corbits_hub: "hub_a", corbits_allocation: "sal_1", corbits_generation: "1", corbits_sidecar: "sc_sal_1" });
    expect(first?.config.env).toMatchObject({ HUB_WS_URL: HUB_URL, SIDECAR_ID: "sc_sal_1", SIDECAR_TOKEN: "tok_sc_sal_1", SIDECAR_ADAPTER_MANIFEST: JSON.stringify(MANIFEST) });
    expect(first?.config.env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"]).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.config.env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"]).not.toBe(first?.config.env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"]);
  });

  test("the sweep destroys this hub's unheld machines and keeps held, other hubs' and newer ones", async () => {
    const fly = fakeFly();
    const mine = subject(fly, "hub_a").provisioner;
    const theirs = subject(fly, "hub_b").provisioner;
    for (const [provisioner, allocationId] of [[mine, "sal_held"], [mine, "sal_leaked"], [theirs, "sal_other"]] as const) {
      await provisioner.ensure(ensureRequest(allocationId));
    }
    // The listing lags by one call; this one catches it up.
    await fly.api.list({});
    async function activeWhileOneStarts() {
      await mine.ensure(ensureRequest("sal_new"));
      return new Set(["sal_held"]);
    }
    expect(await sweepFlySidecars({ machines: fly.api, hubId: "hub_a" }, activeWhileOneStarts)).toBe(1);
    const states = fly.present().map((machine) => [machine.config.metadata["corbits_allocation"], machine.state]);
    expect(states).toEqual([["sal_held", "started"], ["sal_leaked", "destroying"], ["sal_other", "started"], ["sal_new", "started"]]);
  });
});
