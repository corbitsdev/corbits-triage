// A policy of only deterministic rules, settled on the pass the pull request opens.
import { expect, test } from "bun:test";
import { VERDICT_LABELS } from "@corbits/triage-contracts";
import { chainStack, DETERMINISTIC, isLiveDeployment, once } from "./chain.ts";
import { sha, pullOf, comments, labelled } from "./github.ts";

const { github, model, pushed, managers, settled, verdictsOf } = chainStack();

const deterministic = once(async function deterministic() {
  const head = sha("deterministic-1");
  const [before, missed] = [(await managers()).length, github.misses.length];
  await pushed(DETERMINISTIC, pullOf(1, head));
  const claim = await settled(DETERMINISTIC, 1);
  return { head, claim, deployed: (await managers()).slice(before), writes: github.writesTo(DETERMINISTIC, 1), misses: github.misses.slice(missed) };
});

test("a policy of only deterministic rules posts its verdict at once and the manager stops", async () => {
  const { head, claim, deployed, writes, misses } = await deterministic();
  expect(misses).toEqual([]);
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
  expect(claim).toMatchObject({ status: "ended", history: [{ head, runId: deployed[0]!.id }] });
  expect(deployed).toHaveLength(1);
  expect(isLiveDeployment(deployed[0]!.status)).toBe(false);
  expect(model.decisions).toEqual([]);
});

test("the hub records the verdict from the manager's done", async () => {
  const { head, claim } = await deterministic();
  expect(await verdictsOf(DETERMINISTIC, 1)).toEqual([expect.objectContaining({ run_id: claim.history[0]!.runId, head_sha: head, run_status: "completed" })]);
});
