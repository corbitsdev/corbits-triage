// A pull request opened while its listener is being replaced.
import { expect, test } from "bun:test";
import { TRIAGE_LISTENERS, VERDICT_LABELS } from "@corbits/triage-contracts";
import { chainStack, UNROUTED, isLiveDeployment, sha, pullOf, comments, labelled, once } from "./chain.ts";

// The default pass interval, so only the hub's short retry and its pass on a listener starting can mail the head in time.
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const UNROUTED_RETRY_MS = 15_000;
const REPLACED_MS = 3 * 60_000;

const chain = chainStack({ TRIAGE_RECONCILE_INTERVAL_MS: String(RECONCILE_INTERVAL_MS) });
const { github, pushed, until, rows } = chain;

/** The GitHub listener's live deployments, oldest first. */
async function listeners(): Promise<string[]> {
  const found = await rows(`select r.id, r.status, r.cancellation_requested_at from workflow_run r join workflow_definition d on d.id = r.definition_id left join workflow_run_launch_spec s on s.anchor_run_id = r.id where r.id = r.anchor_run_id and coalesce(s.frozen_approval_bundle -> 'projection' ->> 'id', d.name) = '${TRIAGE_LISTENERS.github}' order by r.created_at`);
  return found.filter((row) => isLiveDeployment(String(row["status"])) && row["cancellation_requested_at"] === null).map((row) => String(row["id"]));
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
  const { transport, tenantId } = chain.workspace;
  // Stopped through stock's stop-run route, the listener's run is gone until the hub rolls the workspace again.
  await transport.fetch("DELETE", `/api/tenants/${tenantId}/workflows/runs/${listener}`);
  const head = sha("unrouted-1");
  const missed = github.misses.length;
  await pushed(UNROUTED, pullOf(1, head));
  const failed = await until("the pull request's mail to reach no listener", function seen() {
    return logged("forward_failed").find((entry) => entry["repo"] === UNROUTED);
  });
  const live = await until("a replacement listener to run", function seen() {
    return logged("workflow_release_live").find((entry) => entry["deployment"] !== listener);
  }, REPLACED_MS);
  const sent = await until("the pull request's mail to go out again", function seen() {
    return logged("triage_requeued").find((entry) => entry["repo"] === UNROUTED && entry["pr"] === 1);
  });
  await until("the verdict", function posted() {
    return comments(github.writesTo(UNROUTED, 1)).length > 0 ? true : undefined;
  });
  return { listener, failed, live, sent, writes: github.writesTo(UNROUTED, 1), misses: github.misses.slice(missed) };
});

test("a pull request opened while its listener is replaced is mailed to the replacement within the short retry of it running, and gets its verdict", async () => {
  const { listener, failed, live, sent, writes, misses } = await unrouted();
  expect(msOf(failed)).toBeLessThan(msOf(live));
  expect(live["deployment"]).not.toBe(listener);
  expect(msOf(sent) - msOf(live)).toBeLessThanOrEqual(UNROUTED_RETRY_MS);
  expect(misses).toEqual([]);
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
});
