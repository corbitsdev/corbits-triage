// A head whose CI finishes with no event, read again by its waiting manager.
import { expect, test } from "bun:test";
import { VERDICT_LABELS } from "@corbits/triage-contracts";
import { chainStack, REREAD, SETTLE_MS, sha, pullOf, once } from "./chain.ts";

const { github, pushed, until, claimOf, managers, settled, verdictsOf } = chainStack();

// The manager reads a waiting head again 5 minutes into its wait; give that pass its polls and a settle on top.
const REREAD_MS = 5 * 60_000 + SETTLE_MS;

const reread = once(async function reread() {
  const head = sha("reread-1");
  const before = (await managers()).length;
  github.setChecks(REREAD, head, [{ name: "build", status: "in_progress", conclusion: null }]);
  await pushed(REREAD, pullOf(1, head));
  await until("the in-progress comment", () => (github.pull(REREAD, 1).comments.length > 0 || undefined));
  const whileWaiting = { comments: github.pull(REREAD, 1).comments.map((comment) => comment.body), claim: (await claimOf(REREAD, 1))! };
  // CI finishes with no check_run, as on a host whose builds send no webhook.
  github.setChecks(REREAD, head, [{ name: "build", status: "completed", conclusion: "success" }]);
  const claim = await settled(REREAD, 1, whileWaiting.claim.history.length + 1, REREAD_MS);
  return { head, whileWaiting, claim, deployed: (await managers()).slice(before), pull: github.pull(REREAD, 1) };
});

test("a head whose CI finishes with no event is read again by its waiting manager within five minutes, and the verdict replaces the in-progress comment in place", async () => {
  const { head, whileWaiting, claim, deployed, pull } = await reread();
  expect(whileWaiting.comments).toEqual([expect.stringContaining("**Triage: In progress**\n\nTriage is waiting for CI to finish")]);
  expect(whileWaiting.claim.status).toBe("live");
  expect(deployed).toHaveLength(1);
  expect(new Set(claim.history.map((pass) => pass.runId))).toEqual(new Set([deployed[0]!.id]));
  expect(claim).toMatchObject({ status: "ended" });
  expect(pull.labels).toEqual([VERDICT_LABELS.pass]);
  expect(pull.comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(await verdictsOf(REREAD, 1)).toEqual([expect.objectContaining({ run_id: deployed[0]!.id, head_sha: head, run_status: "completed" })]);
});
