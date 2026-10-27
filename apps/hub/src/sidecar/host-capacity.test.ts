import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHostCapacity, shortfall, SIDECAR_BYTES } from "./host-capacity.js";

const MiB = 1024 ** 2;
const roots: string[] = [];

async function box(files: Record<string, string>): Promise<{ cgroupRoot: string; meminfo: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "host-capacity-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), `${text}\n`);
  }
  return { cgroupRoot: path.join(root, "cgroup"), meminfo: path.join(root, "meminfo") };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test("a cgroup v2 limit counts reclaimable cache free and decides over the host's memory, a missing inactive_file counting none", async () => {
  const cached = await box({
    "cgroup/memory.max": String(1024 * MiB),
    "cgroup/memory.current": String(600 * MiB),
    "cgroup/memory.stat": `anon ${500 * MiB}\ninactive_file ${100 * MiB}`,
    meminfo: "MemAvailable:   16 kB",
  });
  expect(await createHostCapacity(cached).freeBytes()).toBe(524 * MiB);
  const uncached = await box({
    "cgroup/memory.max": String(1024 * MiB),
    "cgroup/memory.current": String(600 * MiB),
    "cgroup/memory.stat": `anon ${600 * MiB}`,
  });
  expect(await createHostCapacity(uncached).freeBytes()).toBe(424 * MiB);
});

test("a cgroup v1 limit is read the same way", async () => {
  const limited = await box({
    "cgroup/memory/memory.limit_in_bytes": String(512 * MiB),
    "cgroup/memory/memory.usage_in_bytes": String(100 * MiB),
    "cgroup/memory/memory.stat": "total_inactive_file 0",
  });
  expect(await createHostCapacity(limited).freeBytes()).toBe(412 * MiB);
});

test("without a cgroup limit MemAvailable decides, and a box reporting neither has no figure", async () => {
  const unlimited = await box({ "cgroup/memory.max": "max", meminfo: `MemTotal: ${4096 * 1024} kB\nMemAvailable: ${256 * 1024} kB` });
  expect(await createHostCapacity(unlimited).freeBytes()).toBe(256 * MiB);
  expect(await createHostCapacity(await box({})).freeBytes()).toBeUndefined();
});

test("the sidecar needs one footprint free, and no figure never declines", () => {
  expect(shortfall(SIDECAR_BYTES)).toBeUndefined();
  expect(shortfall(SIDECAR_BYTES / 2)).toBe(`${SIDECAR_BYTES / 2 / MiB} MiB free, ${SIDECAR_BYTES / MiB} MiB needed`);
  expect(shortfall(undefined)).toBeUndefined();
});
