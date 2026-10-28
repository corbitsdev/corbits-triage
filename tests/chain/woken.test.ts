// A manager that waits for the judge it mailed, and the judge's report reaching it through the hub.
import { expect, test } from "bun:test";
import { VERDICT_LABELS } from "@corbits/triage-contracts";
import { chainStack, WOKEN, SETTLE_MS, isLiveDeployment, sha, pullOf, type Claim, comments, labelled, once } from "./chain.ts";

const { github, model, pushed, until, claimOf, managers, settled, verdictsOf } = chainStack();

const woken = once(async function woken() {
  const head = sha("woken-1");
  const [before, asked, missed] = [(await managers()).length, model.decisions.length, github.misses.length];
  const release = model.hold();
  let whileJudging: Claim;
  try {
    await pushed(WOKEN, pullOf(1, head));
    // The judge's answer is held, so its manager mails it and polls on with the judge still out.
    whileJudging = await until("the manager to wait on its judge", async function judging() {
      const claim = await claimOf(WOKEN, 1);
      return claim?.status === "live" && claim.history.length > 0 ? claim : undefined;
    });
    await Bun.sleep(SETTLE_MS / 2);
  } finally {
    release();
  }
  const live = (await managers()).slice(before);
  const claim = await settled(WOKEN, 1, whileJudging.history.length + 1);
  return { head, whileJudging, live, claim, deployed: (await managers()).slice(before), asked: model.decisions.slice(asked).map((row) => row.id), writes: github.writesTo(WOKEN, 1), pull: github.pull(WOKEN, 1), misses: github.misses.slice(missed) };
});

test("a manager waits for the judge it mailed, and the judge's report reaches it through the hub, so it posts the verdict itself and then ends", async () => {
  const { head, whileJudging, live, claim, deployed, asked, writes, pull, misses } = await woken();
  expect(misses).toEqual([]);
  expect(whileJudging.runId).toBe(live[0]!.id);
  expect(live.map((run) => isLiveDeployment(run.status))).toEqual([true]);
  expect(deployed.map((run) => run.id)).toEqual([live[0]!.id]);
  expect(claim).toMatchObject({ status: "ended" });
  expect(claim.history.at(-1)).toMatchObject({ head, runId: deployed[0]!.id });
  expect(asked).toContain("focused");
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: In progress**\n\nTriage is waiting for the decision model's answer")]);
  expect(pull.comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
  expect(await verdictsOf(WOKEN, 1)).toEqual([expect.objectContaining({ run_id: deployed[0]!.id, head_sha: head, run_status: "completed" })]);
});
