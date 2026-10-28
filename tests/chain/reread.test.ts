// A head whose CI finishes with no event: its manager ended while it waited, and the hub's reconcile pass wakes the next.
import { expect, test } from "bun:test";
import { VERDICT_LABELS } from "@corbits/triage-contracts";
import { RECONCILE_INTERVAL_MS } from "./stack.ts";
import { chainStack, REREAD, SETTLE_MS, isLiveDeployment, sha, pullOf, once } from "./chain.ts";

const { github, pushed, until, managers, settled, verdictsOf } = chainStack();

const reread = once(async function reread() {
  const head = sha("reread-1");
  const before = (await managers()).length;
  github.setChecks(REREAD, head, [{ name: "build", status: "in_progress", conclusion: null }]);
  await pushed(REREAD, pullOf(1, head));
  await until("the in-progress comment", () => (github.pull(REREAD, 1).comments.length > 0 || undefined));
  const ended = await settled(REREAD, 1);
  const whileWaiting = { comments: github.pull(REREAD, 1).comments.map((comment) => comment.body), claim: ended, managers: (await managers()).slice(before) };
  // CI finishes with no check_run, as on a host whose builds send no webhook.
  github.setChecks(REREAD, head, [{ name: "build", status: "completed", conclusion: "success" }]);
  const claim = await settled(REREAD, 1, ended.history.length + 1, 2 * RECONCILE_INTERVAL_MS + SETTLE_MS);
  return { head, whileWaiting, claim, deployed: (await managers()).slice(before), pull: github.pull(REREAD, 1) };
});

test("a head whose CI finishes with no event, after its manager ended to wait, is woken by the reconcile pass, and the verdict replaces the in-progress comment in place", async () => {
  const { head, whileWaiting, claim, deployed, pull } = await reread();
  expect(whileWaiting.comments).toEqual([expect.stringContaining("**Triage: In progress**\n\nTriage is waiting for CI to finish")]);
  expect(whileWaiting.claim.status).toBe("ended");
  expect(whileWaiting.managers.map((run) => isLiveDeployment(run.status))).toEqual([false]);
  expect(deployed).toHaveLength(2);
  expect(claim).toMatchObject({ status: "ended" });
  expect(claim.history.at(-1)).toMatchObject({ head, runId: deployed[1]!.id });
  expect(pull.labels).toEqual([VERDICT_LABELS.pass]);
  expect(pull.comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(await verdictsOf(REREAD, 1)).toEqual([expect.objectContaining({ run_id: deployed[1]!.id, head_sha: head, run_status: "completed" })]);
});
