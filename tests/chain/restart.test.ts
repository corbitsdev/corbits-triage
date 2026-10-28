// A hub restart while a manager is live: boot retires the sidecars the old process started and removes their data, and
// fresh ones serve both the next pull request and the one whose manager the restart lost.
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chainStack, RESTARTED, sha, pullOf, once } from "./chain.ts";

const chain = chainStack();
const { github, pushed, until, rows, claimOf, settled, verdictsOf } = chain;

type Started = { sidecarId: string; pid: number };

function sidecarsStarted(from: number, to?: number): Started[] {
  return chain.hub.logs.slice(from, to).filter((line) => line.includes('"msg":"local_sidecar_started"')).map((line) => JSON.parse(line) as Started);
}

function sidecarDirs(): string[] {
  const root = join(chain.hub.dataDir, "local-sidecars");
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("sal_")).map((entry) => join(root, entry.name));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function verdict(number: number): Promise<Record<string, unknown>> {
  return until(`${RESTARTED}#${number}'s verdict`, async function recorded() {
    const [first] = await verdictsOf(RESTARTED, number);
    return first;
  });
}

const restarted = once(async function restarted() {
  await pushed(RESTARTED, pullOf(1, sha("restarted-1")));
  await settled(RESTARTED, 1);
  const release = github.hold(RESTARTED, 2);
  await pushed(RESTARTED, pullOf(2, sha("restarted-2")));
  await until("the second manager's claim", async function claimed() {
    const claim = await claimOf(RESTARTED, 2);
    return claim?.status === "live" ? claim : undefined;
  });
  const restartedAt = chain.hub.logs.length;
  const [before, dirs] = [sidecarsStarted(0, restartedAt), sidecarDirs()];
  try {
    await chain.hub.restart();
  } finally {
    release();
  }
  await pushed(RESTARTED, pullOf(3, sha("restarted-3")));
  const [lost, next] = [await verdict(2), await verdict(3)];
  const placed = await rows("select sidecar_id from sidecar_allocation where status = 'allocated'");
  return { before, dirs, after: sidecarsStarted(restartedAt), placed: placed.map((row) => String(row["sidecar_id"])), lost, next };
});

test("a pull request opened after the restart gets its verdict", async () => {
  const { next } = await restarted();
  expect(next).toMatchObject({ head_sha: sha("restarted-3") });
});

test("the pull request whose manager the restart lost still gets its verdict", async () => {
  const { lost } = await restarted();
  expect(lost).toMatchObject({ head_sha: sha("restarted-2") });
});

test("the old sidecars' processes and data are gone, and each deployment placed since runs in a fresh process", async () => {
  const { before, dirs, after, placed } = await restarted();
  expect(dirs.length).toBeGreaterThan(0);
  expect(before.filter((sidecar) => alive(sidecar.pid))).toEqual([]);
  expect(dirs.filter((dir) => existsSync(dir))).toEqual([]);
  const fresh = new Map(after.map((sidecar) => [sidecar.sidecarId, sidecar.pid]));
  expect(placed.length).toBeGreaterThan(0);
  expect(placed.filter((sidecarId) => !fresh.has(sidecarId))).toEqual([]);
  expect(placed.filter((sidecarId) => !alive(fresh.get(sidecarId)!))).toEqual([]);
});
