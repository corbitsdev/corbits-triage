// A pull request opened while its listener is being replaced.
import { expect, test } from "bun:test";
import { TRIAGE_LISTENERS, VERDICT_LABELS } from "@corbits/triage-contracts";
import { chainStack, UNROUTED, isLiveDeployment, once } from "./chain.ts";
import { resume } from "./stack.ts";
import { sha, pullOf, comments, labelled } from "./github.ts";

// Longer than the scenario runs, so only the hub's short retry and its pass on a listener starting can mail the head.
const RECONCILE_INTERVAL_MS = 60 * 60_000;
/**
 * Stock drops a silent sidecar's socket after its one-minute ping timeout, the one real wait left: a sidecar pings on
 * stock's own 30-second interval, which nothing here shortens.
 */
const DISCONNECT_MS = 90_000;
const REPLACED_MS = 3 * 60_000;

const chain = chainStack({ TRIAGE_RECONCILE_INTERVAL_MS: String(RECONCILE_INTERVAL_MS) });
const { github, pushed, until, rows } = chain;

/** The GitHub listener's live deployments not being stopped, oldest first, and the pid of the local sidecar each runs on. */
async function listeners(): Promise<{ id: string; pid: number }[]> {
  const found = await rows(`select r.id, r.status, r.cancellation_requested_at, a.external_ref from workflow_run r join workflow_definition d on d.id = r.definition_id left join workflow_run_launch_spec s on s.anchor_run_id = r.id join sidecar_allocation a on a.anchor_run_id = r.id where r.id = r.anchor_run_id and coalesce(s.frozen_approval_bundle -> 'projection' ->> 'id', d.name) = '${TRIAGE_LISTENERS.github}' order by r.created_at`);
  return found.filter((row) => isLiveDeployment(String(row["status"])) && row["cancellation_requested_at"] === null).map((row) => ({ id: String(row["id"]), pid: Number(row["external_ref"]) }));
}

function logged(msg: string): Array<Record<string, unknown>> {
  return chain.hub.logs.filter((line) => line.includes(`"msg":"${msg}"`)).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function msOf(entry: Record<string, unknown>): number {
  return Date.parse(String(entry["ts"]));
}

const unrouted = once(async function unrouted() {
  const [listener] = await listeners();
  if (!listener) throw new Error("The GitHub listener is not live.");
  const head = sha("unrouted-1");
  const missed = github.misses.length;
  // A frozen sidecar stops pinging, so stock drops its socket and the listener's route while its run stays live.
  process.kill(listener.pid, "SIGSTOP");
  try {
    await until("stock to drop the listener's sidecar", function dropped() {
      return chain.hub.logs.some((line) => line.includes("Sidecar") && line.includes("disconnected")) ? true : undefined;
    }, DISCONNECT_MS);
    await pushed(UNROUTED, pullOf(1, head));
    // The webhook's mail and then the reconciler's both reach no listener; a head not held for one would now back off.
    await until("the reconciler's mail to reach no listener too", function seen() {
      return logged("forward_failed").filter((entry) => entry["repo"] === UNROUTED).length >= 2 ? true : undefined;
    });
    const { transport, tenantId } = chain.workspace;
    // Stopped through stock's stop-run route, the listener's run is gone until the hub rolls the workspace again.
    await transport.fetch("DELETE", `/api/tenants/${tenantId}/workflows/runs/${listener.id}`);
  } finally {
    resume(listener.pid);
  }
  const live = await until("a replacement listener to run", function seen() {
    return logged("workflow_release_live").find((entry) => entry["deployment"] !== listener.id);
  }, REPLACED_MS);
  const sent = await until("the pull request's mail to go out again", function seen() {
    return logged("triage_requeued").find((entry) => entry["repo"] === UNROUTED && entry["pr"] === 1);
  }, REPLACED_MS);
  await until("the verdict", function posted() {
    return comments(github.writesTo(UNROUTED, 1)).length > 0 ? true : undefined;
  });
  const failed = logged("forward_failed").filter((entry) => entry["repo"] === UNROUTED);
  return { listener, failed, live, sent, writes: github.writesTo(UNROUTED, 1), misses: github.misses.slice(missed) };
});

test("a pull request opened while its listener is replaced, whose mail already spent an attempt, is mailed to the replacement once it runs and gets its verdict", async () => {
  const { listener, failed, live, sent, writes, misses } = await unrouted();
  expect(failed.length).toBeGreaterThanOrEqual(2);
  expect(failed.every((entry) => msOf(entry) < msOf(live) && entry["level"] === "info")).toBe(true);
  expect(live["deployment"]).not.toBe(listener.id);
  expect(msOf(sent)).toBeGreaterThanOrEqual(msOf(live));
  expect(misses).toEqual([]);
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
});
