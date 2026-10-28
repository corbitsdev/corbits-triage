// A manager that ends while the judge is out, and the judge's report waking the next.
import { expect, test } from "bun:test";
import { VERDICT_LABELS } from "@corbits/triage-contracts";
import { WOKEN, isLiveDeployment, github, model, sha, pullOf, pushed, type Claim, managers, settled, verdictsOf, comments, labelled, once } from "./chain.ts";

const woken = once(async function woken() {
  const head = sha("woken-1");
  const [before, asked, missed] = [(await managers()).length, model.decisions.length, github.misses.length];
  const release = model.hold();
  let releasedAt: Date;
  let ended: Claim;
  let first: Awaited<ReturnType<typeof managers>>;
  try {
    await pushed(WOKEN, pullOf(1, head));
    // The judge's answer is held, so its manager mails it, waits out its 30 seconds and ends with the judge still out.
    ended = await settled(WOKEN, 1);
    first = (await managers()).slice(before);
  } finally {
    releasedAt = new Date();
    release();
  }
  const claim = await settled(WOKEN, 1, ended.history.length + 1);
  return { head, ended, first, releasedAt, claim, deployed: (await managers()).slice(before), asked: model.decisions.slice(asked).map((row) => row.id), writes: github.writesTo(WOKEN, 1), misses: github.misses.slice(missed) };
});

test("a manager ends after it mails the judge, and the judge's report wakes a fresh manager through the hub, which posts the verdict", async () => {
  const { head, ended, first, releasedAt, claim, deployed, asked, writes, misses } = await woken();
  expect(misses).toEqual([]);
  expect(ended.status).toBe("ended");
  expect(first).toHaveLength(1);
  expect(isLiveDeployment(first[0]!.status)).toBe(false);
  expect(deployed).toHaveLength(2);
  expect(deployed[1]!.createdAt.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime() - 1_000);
  expect(claim).toMatchObject({ status: "ended" });
  expect(claim.history.at(-1)).toMatchObject({ head, runId: deployed[1]!.id });
  expect(asked).toContain("focused");
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
  expect(await verdictsOf(WOKEN, 1)).toEqual([expect.objectContaining({ run_id: deployed[1]!.id, head_sha: head, run_status: "completed" })]);
});
