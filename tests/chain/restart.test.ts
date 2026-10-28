// A hub restart while a manager is live: the boot retires the old local sidecar and its data, and a fresh one serves
// both the next pull request and the one whose manager the restart lost.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chainStack, RESTARTED, sha, pullOf, once } from "./chain.ts";

const chain = chainStack();
const { github, pushed, until, rows, claimOf, settled, verdictsOf } = chain;

function signingKey(): string {
  return readFileSync(join(chain.hub.dataDir, "local-sidecars", "sidecar", ".sidecar-signing", "ed25519.public"), "utf8");
}

function sidecarsStarted(from: number, to?: number): { sidecarId: string; pid: number }[] {
  return chain.hub.logs.slice(from, to).filter((line) => line.includes('"msg":"local_sidecar_started"')).map((line) => JSON.parse(line) as { sidecarId: string; pid: number });
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
  const [before, key] = [sidecarsStarted(0).at(-1)!, signingKey()];
  const restartedAt = chain.hub.logs.length;
  try {
    await chain.hub.restart();
  } finally {
    release();
  }
  await pushed(RESTARTED, pullOf(3, sha("restarted-3")));
  const [lost, next] = [await verdict(2), await verdict(3)];
  return { before, key, after: sidecarsStarted(restartedAt), lost, next };
});

test("a pull request opened after the restart gets its verdict", async () => {
  const { next } = await restarted();
  expect(next).toMatchObject({ head_sha: sha("restarted-3") });
});

test("the pull request whose manager the restart lost still gets its verdict", async () => {
  const { lost } = await restarted();
  expect(lost).toMatchObject({ head_sha: sha("restarted-2") });
});

test("one fresh local sidecar runs after the restart, and the old one's process and data are gone", async () => {
  const { before, key, after } = await restarted();
  expect(after).toHaveLength(1);
  expect(alive(after[0]!.pid)).toBe(true);
  expect(alive(before.pid)).toBe(false);
  expect(await rows("select id from sidecar where retired_at is null")).toEqual([{ id: after[0]!.sidecarId }]);
  expect(signingKey()).not.toBe(key);
});
