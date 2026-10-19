// The hub-side provisioner over HTTP to a real agent whose QEMU is replaced by a recorder; docs/provisioners/qemu.md has the live check.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeProvisionerConformance } from "@corbits/provisioner-conformance";
import { createQemuAgent } from "./agent.js";
import { createQemuSidecarProvisioner, sweepQemuSidecars, type QemuHost } from "./index.js";

const TOKEN = "t".repeat(32);
const MANIFEST = [{ provider: "it's", specifier: "file:///app/packages/a $b.ts", export: "adapter" }];

function setup() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "qemu-agent-"));
  const launched: (readonly string[])[] = [];
  const agent = createQemuAgent({
    token: TOKEN,
    image: { kernel: "/boot/vmlinux", rootfs: "/var/lib/corbits-qemu/rootfs.ext4" },
    stateDir,
    memoryBytes: 64 * 1024 ** 3,
    launch(args) {
      launched.push(args);
      const { promise, resolve } = Promise.withResolvers<void>();
      return { exited: promise, kill: resolve };
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: agent.handle });
  const host: QemuHost = { url: server.url.href, token: TOKEN };
  const provisioner = createQemuSidecarProvisioner({ host, hubId: "hub", adapterManifest: MANIFEST, hubWebSocketUrl: "wss://triage.example.com/api/sidecars/ws" });

  function argsOf(allocationId: string): readonly string[] {
    const [only, ...rest] = agent.vms().filter((vm) => vm.allocationId === allocationId);
    if (only === undefined || rest.length > 0) throw new Error(`Expected one VM for ${allocationId}`);
    const args = launched.find((candidate) => candidate.includes(`name=opt/corbits/env,file=${only.envFile}`));
    if (args === undefined) throw new Error("The VM was not launched");
    return args;
  }

  async function dispose() {
    await sweepQemuSidecars({ host, hubId: "hub" }, new Set());
    await server.stop(true);
    rmSync(stateDir, { recursive: true });
  }

  return { agent, host, provisioner, argsOf, dispose };
}

describeProvisionerConformance("qemu", async () => {
  const { agent, provisioner, argsOf, dispose } = setup();
  return {
    provisioner,
    async live(allocationId) {
      return agent.vms().filter((vm) => vm.allocationId === allocationId).map(({ generation, sidecarId }) => ({ generation, sidecarId }));
    },
    capabilityChecks: {
      async "isolation:workload"(allocationId) {
        const args = argsOf(allocationId).join(" ");
        if (!args.includes("-M microvm -enable-kvm") || !args.includes("snapshot=on")) throw new Error("The sidecar is not in a KVM microVM with a throwaway disk");
        if (/-virtfs|-fsdev|hostfwd|guestfwd/.test(args)) throw new Error("The sidecar shares host files or ports");
      },
      async "network:outbound"(allocationId) {
        if (!argsOf(allocationId).includes("user,id=net")) throw new Error("The sidecar has no network");
      },
    },
    dispose,
  };
});

test("the guest reads back the sidecar's env exactly, from a file only the agent can read", async () => {
  const { agent, host, provisioner, dispose } = setup();
  try {
    expect(await fetch(new URL("/health", host.url))).toHaveProperty("status", 401);
    await provisioner.ensure({ tenantId: "t", allocationId: "a", anchorRunId: "r", generation: 1, sidecarId: "s", token: "tok", hubWebSocketUrl: "ws://127.0.0.1:3000/api/sidecars/ws" });
    const [vm] = agent.vms();
    if (vm === undefined) throw new Error("No VM");
    expect((await Bun.file(vm.envFile).stat()).mode & 0o777).toBe(0o600);
    expect(readFileSync(vm.envFile, "utf8")).toContain("SIDECAR_CREDENTIAL_ENCRYPTION_KEY=");
    const read = await Bun.$`sh -c ${'set -a; . "$0"; printf %s "$SIDECAR_ADAPTER_MANIFEST|$HUB_WS_URL|$SIDECAR_TOKEN"'} ${vm.envFile}`.env({}).text();
    expect(read).toBe(`${JSON.stringify(MANIFEST)}|wss://triage.example.com/api/sidecars/ws|tok`);
  } finally {
    await dispose();
  }
});
