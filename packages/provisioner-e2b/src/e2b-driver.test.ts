import { afterEach, expect, test } from "bun:test";
import type { EnsureSidecarRequest } from "@intx/hub-sessions";
import { createDriverProvisioner } from "@corbits/provisioner";
import { createE2bDriver } from "./e2b-driver.js";

type FakeSandbox = { sandboxID: string; state: "running" | "paused"; metadata: Record<string, string> };
type Started = { sandboxId: string | null; token: string | null; envs: Record<string, string>; args: string[] };

function frame(flags: number, message: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const bytes = new Uint8Array(5 + json.length);
  bytes[0] = flags;
  new DataView(bytes.buffer).setUint32(1, json.length);
  bytes.set(json, 5);
  return bytes;
}

function matches(sandbox: FakeSandbox, filter: URLSearchParams): boolean {
  return [...filter].every(([key, value]) => sandbox.metadata[key] === value);
}

/** The slice of E2B's control plane and envd that the driver speaks, outliving any one hub. */
function fakeE2b() {
  const sandboxes = new Map<string, FakeSandbox>();
  const created: unknown[] = [];
  const started: Started[] = [];
  const failures = { create: false, start: false };
  let next = 0;

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("X-API-Key") !== "key" && url.pathname !== "/process.Process/Start") {
      return Response.json({ code: 401, message: "no key" }, { status: 401 });
    }
    if (request.method === "POST" && url.pathname === "/v2/sandboxes") {
      if (failures.create) {
        return Response.json({ code: 503, error_code: "sandbox_capacity_unavailable", message: "no node" }, { status: 503 });
      }
      const body = await request.json() as { metadata: Record<string, string> };
      created.push(body);
      next += 1;
      const sandbox: FakeSandbox = { sandboxID: `sbx${String(next)}`, state: "running", metadata: body.metadata };
      sandboxes.set(sandbox.sandboxID, sandbox);
      return Response.json({ sandboxID: sandbox.sandboxID, envdAccessToken: `envd-${sandbox.sandboxID}`, templateID: "tpl" }, { status: 201 });
    }
    if (request.method === "GET" && url.pathname === "/v2/sandboxes") {
      const filter = new URLSearchParams(url.searchParams.get("metadata") ?? "");
      return Response.json([...sandboxes.values()].filter((sandbox) => matches(sandbox, filter)));
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/sandboxes/")) {
      const id = url.pathname.slice("/sandboxes/".length);
      if (!sandboxes.delete(id)) return Response.json({ code: 404, message: "not found" }, { status: 404 });
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname === "/process.Process/Start") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const body = JSON.parse(new TextDecoder().decode(bytes.subarray(5))) as { process: { args: string[]; envs: Record<string, string> } };
      started.push({ sandboxId: request.headers.get("E2b-Sandbox-Id"), token: request.headers.get("X-Access-Token"), envs: body.process.envs, args: body.process.args });
      const reply = failures.start
        ? frame(2, { error: { code: "invalid_argument", message: "cwd does not exist" } })
        : frame(0, { event: { start: { pid: 42 } } });
      return new Response(reply, { headers: { "Content-Type": "application/connect+json" } });
    }
    return new Response("unknown route", { status: 404 });
  }

  const server = Bun.serve({ port: 0, fetch: handle });
  return { server, sandboxes, created, started, failures };
}

let fake: ReturnType<typeof fakeE2b>;

afterEach(async () => {
  await fake.server.stop(true);
});

function hub() {
  const url = `http://127.0.0.1:${String(fake.server.port)}`;
  return createDriverProvisioner(
    createE2bDriver({ apiKey: "key", template: "corbits-sidecar", apiUrl: url, sandboxUrl: url, hubRoot: "/srv/hub" }),
    "sidecar-key",
  ).provisioner;
}

function request(generation: number): EnsureSidecarRequest {
  return {
    allocationId: "sal_1",
    generation,
    sidecarId: `sc_${String(generation)}`,
    tenantId: "tnt_1",
    anchorRunId: "run_1",
    token: `tok_${String(generation)}`,
    hubWebSocketUrl: "wss://hub.example/api/sidecars/ws",
    adapterManifest: [
      { provider: "github-app", specifier: "file:///srv/hub/apps/hub/src/github/github-app-adapter-module.ts", export: "install" },
      { provider: "system-one", specifier: "@corbits/system-one", export: "create" },
    ],
  };
}

test("ensure starts the sidecar in a tagged sandbox, a restarted hub adopts it, and destroy kills it", async () => {
  fake = fakeE2b();

  expect(await hub().ensure(request(1))).toEqual({ kind: "accepted", externalRef: "sbx1" });
  expect(fake.created).toEqual([{
    templateID: "corbits-sidecar",
    timeout: 3600,
    autoPause: false,
    metadata: { intxBinding: "e2b:corbits-sidecar", intxAllocation: "sal_1", intxGeneration: "1", intxSidecar: "sc_1" },
  }]);
  const [started] = fake.started;
  expect(started?.sandboxId).toBe("sbx1");
  expect(started?.token).toBe("envd-sbx1");
  expect(started?.args.at(-1)).toContain("exec bun --conditions=intx-src apps/sidecar/src/index.ts");
  expect(started?.envs).toMatchObject({
    HUB_WS_URL: "wss://hub.example/api/sidecars/ws",
    SIDECAR_ID: "sc_1",
    SIDECAR_TOKEN: "tok_1",
    SIDECAR_CREDENTIAL_ENCRYPTION_KEY: "sidecar-key",
    SIDECAR_DATA_DIR: "/home/user/sidecar",
  });
  expect(JSON.parse(started?.envs.SIDECAR_ADAPTER_MANIFEST ?? "[]")).toEqual([
    { provider: "github-app", specifier: "file:///app/apps/hub/src/github/github-app-adapter-module.ts", export: "install" },
    { provider: "system-one", specifier: "@corbits/system-one", export: "create" },
  ]);

  const restarted = hub();
  expect(await restarted.ensure(request(1))).toEqual({ kind: "accepted", externalRef: "sbx1" });
  expect(await restarted.ensure(request(0))).toMatchObject({ kind: "rejected", code: "stale_generation" });
  expect(fake.created).toHaveLength(1);

  expect(await restarted.destroy({ allocationId: "sal_1", generation: 1, sidecarId: "sc_1" })).toEqual({ kind: "destroyed" });
  expect(fake.sandboxes.size).toBe(0);
});

test("a sandbox E2B timed out is replaced, and a paused one is killed before the replacement starts", async () => {
  fake = fakeE2b();
  const provisioner = hub();
  await provisioner.ensure(request(1));

  fake.sandboxes.clear();
  expect(await provisioner.ensure(request(1))).toEqual({ kind: "accepted", externalRef: "sbx2" });

  const paused = fake.sandboxes.get("sbx2");
  if (paused !== undefined) paused.state = "paused";
  expect(await provisioner.ensure(request(1))).toEqual({ kind: "accepted", externalRef: "sbx3" });
  expect([...fake.sandboxes.keys()]).toEqual(["sbx3"]);
});

test("a refused create is a retryable rejection, and a sidecar that fails to start leaves no sandbox", async () => {
  fake = fakeE2b();
  const provisioner = hub();

  fake.failures.create = true;
  expect(await provisioner.ensure(request(1))).toEqual({
    kind: "rejected",
    code: "spawn_failed",
    message: "E2B 503 sandbox_capacity_unavailable: no node",
    retryable: true,
  });

  fake.failures.create = false;
  fake.failures.start = true;
  expect(await provisioner.ensure(request(1))).toMatchObject({ kind: "rejected", code: "spawn_failed", retryable: true });
  expect(fake.sandboxes.size).toBe(0);

  fake.failures.start = false;
  expect(await provisioner.destroy({ allocationId: "sal_1", generation: 1, sidecarId: "sc_1" })).toEqual({ kind: "destroyed" });
});
