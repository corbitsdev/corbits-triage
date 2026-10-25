import { expect, test } from "bun:test";
import { describeProvisionerConformance } from "@corbits/provisioner-test";
import { createRailwaySidecarProvisioner, RailwayCreateRefused, sweepRailwaySidecars, type RailwaySandboxes, type SandboxSummary } from "./index.js";

type FakeSandbox = {
  status: SandboxSummary["status"];
  readonly variables: Readonly<Record<string, string>>;
  launchEnv?: Readonly<Record<string, string>>;
};

/** Railway's sandbox API in memory: what the provisioner may see and do in one environment. */
function fakeRailway() {
  const sandboxes = new Map<string, FakeSandbox>();
  let next = 0;

  function add(sandbox: FakeSandbox): string {
    next += 1;
    const id = `sbx_${String(next)}`;
    sandboxes.set(id, sandbox);
    return id;
  }

  const api: RailwaySandboxes = {
    async list() {
      return [...sandboxes].map(([id, { status }]) => ({ id, status }));
    },
    async readVariables(id, names) {
      const variables = sandboxes.get(id)?.variables;
      if (variables === undefined || !names.every((name) => name in variables)) return undefined;
      return Object.fromEntries(names.map((name) => [name, variables[name]!]));
    },
    async create(variables) {
      return add({ status: "RUNNING", variables });
    },
    async waitUntilRunning() {},
    async launch(id, env) {
      const sandbox = sandboxes.get(id);
      if (sandbox === undefined) throw new Error(`no sandbox ${id}`);
      sandbox.launchEnv = env;
    },
    async destroy(id) {
      const sandbox = sandboxes.get(id);
      if (sandbox !== undefined) sandbox.status = "DESTROYED";
    },
    async templateReady() {},
  };

  function live(hubId: string): Array<{ id: string } & FakeSandbox> {
    return [...sandboxes]
      .filter(([, sandbox]) => sandbox.status !== "DESTROYED" && sandbox.variables["CORBITS_HUB"] === hubId)
      .map(([id, sandbox]) => ({ id, ...sandbox }));
  }

  return { api, sandboxes, add, live };
}

function subject(railway = fakeRailway(), hubId = "hub_a") {
  const provisioner = createRailwaySidecarProvisioner({
    sandboxes: railway.api,
    hubId,
    environmentId: "env_sidecars",
    adapterManifest: [],
    hubWebSocketUrl: "wss://hub.example.com/api/sidecars/ws",
  });
  return { railway, provisioner };
}

function ensureRequest(allocationId: string, sidecarId: string, signal?: AbortSignal) {
  return { allocationId, generation: 1, tenantId: "tnt_a", anchorRunId: "run_a", sidecarId, token: `token_${sidecarId}`, hubWebSocketUrl: "ws://127.0.0.1:1/api/sidecars/ws", ...(signal !== undefined && { signal }) };
}

const LEFT_BY_EARLIER_HUB = { CORBITS_HUB: "hub_a", CORBITS_ALLOCATION: "sal_a", CORBITS_GENERATION: "1", CORBITS_SIDECAR: "sc_a" };

async function noneActive(): Promise<ReadonlySet<string>> {
  return new Set();
}

describeProvisionerConformance("railway", async () => {
  const { railway, provisioner } = subject();
  return {
    provisioner,
    async live(allocationId) {
      return railway
        .live("hub_a")
        .filter((sandbox) => sandbox.variables["CORBITS_ALLOCATION"] === allocationId)
        .map((sandbox) => ({ generation: Number(sandbox.variables["CORBITS_GENERATION"]), sidecarId: sandbox.variables["CORBITS_SIDECAR"]! }));
    },
    capabilityChecks: {
      async "isolation:workload"(allocationId) {
        const own = railway.live("hub_a").filter((sandbox) => sandbox.variables["CORBITS_ALLOCATION"] === allocationId);
        if (own.length !== 1) throw new Error(`Expected one sandbox for ${allocationId}, found ${String(own.length)}`);
      },
    },
    async dispose() {},
  };
});

test("the sidecar's token and key reach its process only, never the sandbox's own variables", async () => {
  const { railway, provisioner } = subject();
  await provisioner.ensure(ensureRequest("sal_a", "sc_a"));
  const [sandbox] = railway.live("hub_a");
  expect(sandbox?.launchEnv).toMatchObject({ SIDECAR_TOKEN: "token_sc_a", HUB_WS_URL: "wss://hub.example.com/api/sidecars/ws" });
  expect(sandbox?.launchEnv?.["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"]).toMatch(/^[0-9a-f]{64}$/);
  expect(Object.keys(sandbox?.variables ?? {}).sort()).toEqual(["CORBITS_ALLOCATION", "CORBITS_GENERATION", "CORBITS_HUB", "CORBITS_SIDECAR"]);
});

test("sandboxes another hub or anyone else made are never destroyed", async () => {
  const railway = fakeRailway();
  const unlabelled = railway.add({ status: "RUNNING", variables: {} });
  const otherHub = railway.add({ status: "RUNNING", variables: { CORBITS_HUB: "hub_b", CORBITS_ALLOCATION: "sal_a", CORBITS_GENERATION: "1", CORBITS_SIDECAR: "sc_a" } });
  const { provisioner } = subject(railway);
  await provisioner.ensure(ensureRequest("sal_a", "sc_a"));
  expect(await provisioner.destroy({ allocationId: "sal_a", generation: 2, sidecarId: "sc_a" })).toEqual({ kind: "destroyed", cleanup: "confirmed" });
  expect(await sweepRailwaySidecars({ sandboxes: railway.api, hubId: "hub_a" }, noneActive)).toEqual({ removed: 0, unsettled: 0 });
  expect(railway.sandboxes.get(unlabelled)?.status).toBe("RUNNING");
  expect(railway.sandboxes.get(otherHub)?.status).toBe("RUNNING");
});

test("a sandbox someone else is still creating holds up no ensure and is left alone", async () => {
  const railway = fakeRailway();
  const creating = railway.add({ status: "CREATING", variables: {} });
  const { provisioner } = subject(railway);
  expect((await provisioner.ensure(ensureRequest("sal_a", "sc_a"))).kind).toBe("accepted");
  const sandbox = railway.sandboxes.get(creating);
  if (sandbox !== undefined) sandbox.status = "RUNNING";
  expect(await provisioner.destroy({ allocationId: "sal_a", generation: 2, sidecarId: "sc_a" })).toEqual({ kind: "destroyed", cleanup: "confirmed" });
  expect(sandbox?.status).toBe("RUNNING");
});

for (const status of ["CREATING", "DESTROYING"] as const) {
  test(`after a restart, destroy is not confirmed while an unknown ${status} sandbox may be ours`, async () => {
    const railway = fakeRailway();
    const left = railway.add({ status, variables: LEFT_BY_EARLIER_HUB });
    const { provisioner } = subject(railway);
    await expect(provisioner.destroy({ allocationId: "sal_a", generation: 2, sidecarId: "sc_a" })).rejects.toThrow("may be this hub's");
    const sandbox = railway.sandboxes.get(left);
    if (sandbox !== undefined) sandbox.status = status === "CREATING" ? "RUNNING" : "DESTROYED";
    expect(await provisioner.destroy({ allocationId: "sal_a", generation: 2, sidecarId: "sc_a" })).toEqual({ kind: "destroyed", cleanup: "confirmed" });
    expect(railway.live("hub_a")).toEqual([]);
  });
}

test("after a restart, the sweep reports a sandbox still being created and removes it once it runs", async () => {
  const railway = fakeRailway();
  const left = railway.add({ status: "CREATING", variables: LEFT_BY_EARLIER_HUB });
  const sidecars = { sandboxes: railway.api, hubId: "hub_a" };
  expect(await sweepRailwaySidecars(sidecars, noneActive)).toEqual({ removed: 0, unsettled: 1 });
  const sandbox = railway.sandboxes.get(left);
  if (sandbox !== undefined) sandbox.status = "RUNNING";
  expect(await sweepRailwaySidecars(sidecars, noneActive)).toEqual({ removed: 1, unsettled: 0 });
});

test("no sandbox is created before the template is built", async () => {
  const { railway, provisioner } = subject();
  railway.api.templateReady = async function building() {
    await new Promise(function never() {});
  };
  const deadline = new AbortController();
  const ensuring = provisioner.ensure(ensureRequest("sal_a", "sc_a", deadline.signal));
  deadline.abort();
  expect(await ensuring).toMatchObject({ kind: "rejected", code: "template_not_ready", retryable: true });
  expect(railway.live("hub_a")).toEqual([]);
});

test("a sandbox of ours still being destroyed is not confirmed gone", async () => {
  const { railway, provisioner } = subject();
  await provisioner.ensure(ensureRequest("sal_a", "sc_a"));
  railway.api.destroy = async function stuck(id) {
    const sandbox = railway.sandboxes.get(id);
    if (sandbox !== undefined) sandbox.status = "DESTROYING";
  };
  await expect(provisioner.destroy({ allocationId: "sal_a", generation: 2, sidecarId: "sc_a" })).rejects.toThrow("still present");
});

test("a sandbox Railway refuses for good is a final rejection; a passing failure is thrown for the hub to retry", async () => {
  const { railway, provisioner } = subject();
  railway.api.create = async function refused() {
    throw new RailwayCreateRefused("Not authorized");
  };
  expect(await provisioner.ensure(ensureRequest("sal_a", "sc_a"))).toMatchObject({ kind: "rejected", code: "railway_refused", message: "Not authorized", retryable: false });
  railway.api.create = async function unavailable() {
    throw new Error("Railway answered HTTP 503: Service unavailable");
  };
  await expect(provisioner.ensure(ensureRequest("sal_b", "sc_b"))).rejects.toThrow("HTTP 503");
  expect(railway.live("hub_a")).toEqual([]);
});

test("a sandbox whose labels cannot be read is never taken for someone else's", async () => {
  const railway = fakeRailway();
  railway.add({ status: "RUNNING", variables: { CORBITS_HUB: "hub_a", CORBITS_ALLOCATION: "sal_a", CORBITS_GENERATION: "1", CORBITS_SIDECAR: "sc_a" } });
  const { provisioner } = subject(railway);
  const readVariables = railway.api.readVariables;
  railway.api.readVariables = async function timeOut() {
    throw new Error("printenv timed out");
  };
  await expect(provisioner.destroy({ allocationId: "sal_a", generation: 2, sidecarId: "sc_a" })).rejects.toThrow("printenv timed out");
  railway.api.readVariables = readVariables;
  expect(await provisioner.destroy({ allocationId: "sal_a", generation: 2, sidecarId: "sc_a" })).toEqual({ kind: "destroyed", cleanup: "confirmed" });
  expect(railway.live("hub_a")).toEqual([]);
});

test("a sidecar that fails to start leaves no sandbox behind", async () => {
  const { railway, provisioner } = subject();
  railway.api.launch = async function refuse() {
    throw new Error("exec refused");
  };
  await expect(provisioner.ensure(ensureRequest("sal_a", "sc_a"))).rejects.toThrow("exec refused");
  expect(railway.live("hub_a")).toEqual([]);
});

test("the sweep destroys only this hub's sandboxes no active allocation holds", async () => {
  const { railway, provisioner } = subject();
  await provisioner.ensure(ensureRequest("sal_active", "sc_a"));
  await provisioner.ensure(ensureRequest("sal_gone", "sc_b"));
  expect(await sweepRailwaySidecars({ sandboxes: railway.api, hubId: "hub_a" }, async function active() {
    return new Set(["sal_active"]);
  })).toEqual({ removed: 1, unsettled: 0 });
  expect(railway.live("hub_a").map((sandbox) => sandbox.variables["CORBITS_ALLOCATION"])).toEqual(["sal_active"]);
});
