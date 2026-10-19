// The host agent: `bun packages/provisioner-qemu/src/main.ts`, run by the corbits-qemu service host/install.sh writes.
import os from "node:os";
import path from "node:path";
import { type } from "arktype";
import { createQemuAgent } from "./agent.js";

const Env = type({
  QEMU_AGENT_TOKEN: "string >= 32",
  QEMU_AGENT_KERNEL: "string",
  QEMU_AGENT_ROOTFS: "string",
  QEMU_AGENT_STATE_DIR: "string",
});
const env = Env.assert(process.env);

const agent = createQemuAgent({
  token: env.QEMU_AGENT_TOKEN,
  image: { kernel: env.QEMU_AGENT_KERNEL, rootfs: env.QEMU_AGENT_ROOTFS },
  stateDir: env.QEMU_AGENT_STATE_DIR,
  memoryBytes: os.totalmem(),
  launch(args) {
    const child = Bun.spawn(["qemu-system-x86_64", ...args], { stdio: ["ignore", "inherit", "inherit"] });
    return { exited: child.exited, kill: () => child.kill() };
  },
});

// A Unix socket, not TCP: the service's IP firewall then keeps VMs off this machine's loopback, and a TLS proxy (docs/provisioners/qemu.md) is the one way in.
Bun.serve({ unix: path.join(env.QEMU_AGENT_STATE_DIR, "agent.sock"), fetch: agent.handle });
