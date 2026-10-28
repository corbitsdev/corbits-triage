// A listener whose sidecar stops answering.
import { expect, test } from "bun:test";
import { TRIAGE_LISTENERS, VERDICT_LABELS } from "@corbits/triage-contracts";
import { RECONCILE_INTERVAL_MS } from "./stack.ts";
import { chainStack, SETTLE_MS, DISCONNECTED, isLiveDeployment, sha, pullOf, comments, labelled, once } from "./chain.ts";

const chain = chainStack();
const { github, pushed, until, rows, settled } = chain;

// The hub drops a silent sidecar's socket after stock's one-minute ping timeout, and the next reconcile pass checks it.
const DISCONNECT_MS = 60_000 + 2 * RECONCILE_INTERVAL_MS + SETTLE_MS;

/** Every GitHub listener deployment's anchor run, oldest first, and the pid of the local sidecar it runs on. */
async function listeners(): Promise<{ id: string; status: string; pid: number }[]> {
  const found = await rows(`select r.id, r.status, a.external_ref from workflow_run r join workflow_definition d on d.id = r.definition_id left join workflow_run_launch_spec s on s.anchor_run_id = r.id join sidecar_allocation a on a.anchor_run_id = r.id where r.id = r.anchor_run_id and coalesce(s.frozen_approval_bundle -> 'projection' ->> 'id', d.name) = '${TRIAGE_LISTENERS.github}' order by r.created_at`);
  return found.map((row) => ({ id: String(row["id"]), status: String(row["status"]), pid: Number(row["external_ref"]) }));
}

function logged(msg: string): Record<string, unknown>[] {
  return chain.hub.logs.filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const disconnected = once(async function disconnected() {
  const [listener] = (await listeners()).filter((row) => isLiveDeployment(row.status));
  if (!listener) throw new Error("The GitHub listener is not live.");
  // A frozen sidecar keeps its process and stops pinging, so stock drops its socket, and with it the listener's route,
  // while the run stays live and its allocation allocated.
  process.kill(listener.pid, "SIGSTOP");
  try {
    await until("a pass to find the listener's sidecar disconnected", function seen() {
      return logged("listener_disconnected").find((entry) => entry["deployment"] === listener.id);
    }, DISCONNECT_MS);
  } finally {
    process.kill(listener.pid, "SIGCONT");
  }
  const head = sha("disconnected-1");
  const missed = github.misses.length;
  await pushed(DISCONNECTED, pullOf(1, head));
  await settled(DISCONNECTED, 1);
  return { listener, unroutable: logged("listener_unroutable"), writes: github.writesTo(DISCONNECTED, 1), misses: github.misses.slice(missed) };
});

test("a listener whose sidecar disconnected is left to stock, and once it reconnects the next pull request gets its verdict", async () => {
  const { listener, unroutable, writes, misses } = await disconnected();
  expect(unroutable).toEqual([]);
  expect((await listeners()).filter((row) => isLiveDeployment(row.status)).map((row) => row.id)).toEqual([listener.id]);
  expect(misses).toEqual([]);
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
});
