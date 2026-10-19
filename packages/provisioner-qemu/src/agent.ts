import { timingSafeEqual } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type } from "arktype";

const MiB = 1024 ** 2;
/** One microVM's memory, as the Docker provisioner gives each container. */
const VM_BYTES = 2048 * MiB;

type QemuImage = {
  /** A kernel with virtio-mmio, virtio-blk, virtio-net, ext4 and fw_cfg sysfs built in. */
  readonly kernel: string;
  /** The sidecar image as a raw ext4 file; each VM writes to a throwaway snapshot of it. */
  readonly rootfs: string;
};

type Launched = {
  readonly exited: Promise<unknown>;
  kill(): void;
};

type QemuAgentOpts = {
  readonly token: string;
  readonly image: QemuImage;
  /** A directory only the agent can read, for each VM's env file. */
  readonly stateDir: string;
  readonly memoryBytes: number;
  launch(args: readonly string[]): Launched;
};

const Ensure = type({
  hubId: "string",
  allocationId: "string",
  generation: "number.integer",
  sidecarId: "string",
  env: "Record<string, string>",
});
const Destroy = type({ hubId: "string", allocationId: "string", generation: "number.integer", sidecarId: "string" });
const Sweep = type({ hubId: "string", activeAllocationIds: "string[]" });

type Vm = typeof Destroy.infer & { readonly id: string; readonly envFile: string; readonly process: Launched };

/** Everything the guest gets from the host: a microVM with KVM, user-mode networking (outbound only) and a throwaway root disk. */
function qemuArgs(image: QemuImage, envFile: string): string[] {
  return [
    "-M", "microvm", "-enable-kvm", "-cpu", "host", "-smp", "2", "-m", String(VM_BYTES / MiB),
    "-nodefaults", "-no-user-config", "-no-reboot", "-display", "none", "-serial", "stdio",
    "-kernel", image.kernel,
    "-append", "console=ttyS0 root=/dev/vda rw init=/sbin/corbits-init panic=-1 quiet",
    "-drive", `id=root,file=${image.rootfs},format=raw,if=none,snapshot=on`,
    "-device", "virtio-blk-device,drive=root",
    "-netdev", "user,id=net",
    "-device", "virtio-net-device,netdev=net",
    "-fw_cfg", `name=opt/corbits/env,file=${envFile}`,
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function envFileOf(env: Record<string, string>): string {
  return Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}\n`).join("");
}

function authorized(request: Request, token: string): boolean {
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Runs one microVM per sidecar and keeps the provisioner contract for each hub: generations are fenced in
 * memory, which is enough because the VMs are this process's children and end with it.
 */
export function createQemuAgent({ token, image, stateDir, memoryBytes, launch }: QemuAgentOpts) {
  const vms = new Map<string, Vm>();
  const fences = new Map<string, { generation: number; destroyedSidecarId?: string }>();

  function ofAllocation(hubId: string, allocationId: string): Vm[] {
    return [...vms.values()].filter((vm) => vm.hubId === hubId && vm.allocationId === allocationId);
  }

  async function remove(vm: Vm): Promise<void> {
    vms.delete(vm.id);
    vm.process.kill();
    await vm.process.exited;
    rmSync(vm.envFile, { force: true });
  }

  // No await until the VM is recorded, so concurrent requests each see the others.
  function ensure(request: typeof Ensure.infer) {
    const key = `${request.hubId}/${request.allocationId}`;
    const fence = fences.get(key);
    const existing = ofAllocation(request.hubId, request.allocationId);
    const observed = Math.max(fence?.generation ?? 0, ...existing.map((vm) => vm.generation));
    if (request.generation < observed) {
      return { kind: "rejected", code: "stale_generation", message: `Generation ${String(request.generation)} is older than ${String(observed)}`, retryable: false };
    }
    if (request.generation === fence?.generation && request.sidecarId === fence.destroyedSidecarId) {
      return { kind: "rejected", code: "sidecar_destroyed", message: `Sidecar ${request.sidecarId} was destroyed`, retryable: false };
    }
    const same = existing.find((vm) => vm.generation === request.generation && vm.sidecarId === request.sidecarId);
    if (same !== undefined) return { kind: "accepted", externalRef: same.id };
    const free = memoryBytes - vms.size * VM_BYTES;
    if (free < VM_BYTES) {
      return { kind: "rejected", code: "capacity_unavailable", message: `${String(Math.floor(free / MiB))} MiB free, ${String(VM_BYTES / MiB)} MiB needed`, retryable: true };
    }
    if (fence === undefined || request.generation > fence.generation) fences.set(key, { generation: request.generation });
    const id = `${request.hubId}-${request.sidecarId}`;
    const envFile = path.join(stateDir, `${id}.env`);
    writeFileSync(envFile, envFileOf(request.env), { mode: 0o600 });
    let launched: Launched;
    try {
      launched = launch(qemuArgs(image, envFile));
    } catch (error) {
      rmSync(envFile, { force: true });
      throw error;
    }
    const { env: _env, ...identity } = request;
    vms.set(id, { ...identity, id, envFile, process: launched });
    return { kind: "accepted", externalRef: id };
  }

  async function destroy(request: typeof Destroy.infer) {
    const key = `${request.hubId}/${request.allocationId}`;
    const fence = fences.get(key);
    if (fence === undefined || request.generation >= fence.generation) {
      fences.set(key, { generation: request.generation, destroyedSidecarId: request.sidecarId });
    }
    const destroyed = ofAllocation(request.hubId, request.allocationId).filter(
      (vm) => vm.generation < request.generation || (vm.generation === request.generation && vm.sidecarId === request.sidecarId),
    );
    await Promise.all(destroyed.map(remove));
    return { kind: "destroyed", cleanup: "confirmed" };
  }

  async function sweep({ hubId, activeAllocationIds }: typeof Sweep.infer) {
    const stale = [...vms.values()].filter((vm) => vm.hubId === hubId && !activeAllocationIds.includes(vm.allocationId));
    await Promise.all(stale.map(remove));
    return { removed: stale.length };
  }

  async function handle(request: Request): Promise<Response> {
    if (!authorized(request, token)) return new Response("unauthorized", { status: 401 });
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return Response.json({ ok: true });
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    const body: unknown = await request.json();
    if (pathname === "/ensure") return Response.json(ensure(Ensure.assert(body)));
    if (pathname === "/destroy") return Response.json(await destroy(Destroy.assert(body)));
    if (pathname === "/sweep") return Response.json(await sweep(Sweep.assert(body)));
    return new Response("not found", { status: 404 });
  }

  return { handle, vms: () => [...vms.values()] };
}
