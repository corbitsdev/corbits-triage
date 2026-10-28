// Whether this box has the memory for one more local sidecar: free memory in
// the container's cgroup (v2, else v1) where a limit is set, else Linux's
// MemAvailable, less one footprint for each sidecar started that has not
// connected yet, as its memory is not in use yet. A box with neither, such as
// a macOS dev machine, never declines: os.freemem there leaves out memory the
// system would reclaim.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MiB = 1024 ** 2;
/** One sidecar's footprint: a pr-triage worker peaked at 784 to 860 MiB RSS over a run (docs/provisioners/local.md, Capacity). */
export const SIDECAR_BYTES = 1024 * MiB;

/** The code a provisioner declines a placement with for want of room; the spawn is retried, not failed. */
export const CAPACITY_UNAVAILABLE = "capacity_unavailable";

export type HostCapacity = {
  /** Undefined when the box reports no figure for it. */
  freeBytes: () => Promise<number | undefined>;
};

export type HostCapacityOpts = {
  cgroupRoot: string;
  meminfo: string;
};

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** A kernel that does not report the field has none of it to reclaim. */
function statBytes(stat: string | undefined, key: string): number {
  const line = stat?.split("\n").find((entry) => entry.startsWith(`${key} `));
  return line === undefined ? 0 : Number(line.slice(key.length + 1));
}

/** The cgroup's free memory, page cache it can reclaim counted free; undefined when no limit is set. */
async function cgroupFreeBytes(root: string): Promise<number | undefined> {
  const v2Limit = await readOptional(path.join(root, "memory.max"));
  if (v2Limit !== undefined) {
    if (v2Limit === "max") return undefined;
    const current = Number(await fs.readFile(path.join(root, "memory.current"), "utf8"));
    return Number(v2Limit) - current + statBytes(await readOptional(path.join(root, "memory.stat")), "inactive_file");
  }
  const v1 = path.join(root, "memory");
  const v1Limit = await readOptional(path.join(v1, "memory.limit_in_bytes"));
  // v1 writes an unlimited cgroup as a near-max integer.
  if (v1Limit === undefined || Number(v1Limit) >= os.totalmem()) return undefined;
  const usage = Number(await fs.readFile(path.join(v1, "memory.usage_in_bytes"), "utf8"));
  return Number(v1Limit) - usage + statBytes(await readOptional(path.join(v1, "memory.stat")), "total_inactive_file");
}

async function memAvailableBytes(meminfo: string): Promise<number | undefined> {
  const kib = (await readOptional(meminfo))?.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1];
  return kib === undefined ? undefined : Number(kib) * 1024;
}

export function createHostCapacity({ cgroupRoot, meminfo }: HostCapacityOpts): HostCapacity {
  return {
    async freeBytes() {
      return (await cgroupFreeBytes(cgroupRoot)) ?? (await memAvailableBytes(meminfo));
    },
  };
}

/** Why there is no room for one more sidecar beside `starting` ones not connected yet, or undefined when there is. */
export function shortfall(free: number | undefined, starting: number): string | undefined {
  const needed = SIDECAR_BYTES * (starting + 1);
  if (free === undefined || free >= needed) return undefined;
  return `${Math.floor(free / MiB)} MiB free, ${needed / MiB} MiB needed`;
}
