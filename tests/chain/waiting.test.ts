// A head whose CI runs after the first post: its manager ends while it waits, and the check event wakes the next.
import { expect, test } from "bun:test";
import { VERDICT_LABELS, WAITING_LABEL } from "@corbits/triage-contracts";
import { deliver } from "./stack.ts";
import { chainStack, WAITING, isLiveDeployment, once } from "./chain.ts";
import { sha, pullOf, comments, labelled } from "./github.ts";

const chain = chainStack();
const { github, model, pushed, until, managers, settled, verdictsOf } = chain;

const waiting = once(async function waiting() {
  const head = sha("waiting-1");
  const [before, asked, missed] = [(await managers()).length, model.decisions.length, github.misses.length];
  github.setChecks(WAITING, head, [{ name: "build", status: "in_progress", conclusion: null }]);
  await pushed(WAITING, pullOf(1, head));
  await until("the Waiting label", () => labelled(github.writesTo(WAITING, 1)).includes(WAITING_LABEL) || undefined);
  // The manager ends once it posted that the head waits; the check event is sent only after.
  const ended = await settled(WAITING, 1);
  const whileWaiting = { writes: [...github.writesTo(WAITING, 1)], claim: ended, managers: (await managers()).slice(before), asked: model.decisions.length - asked };
  github.setChecks(WAITING, head, [{ name: "build", status: "completed", conclusion: "success" }]);
  await deliver(chain.hub, chain.workspace, "check_run", {
    action: "completed", installation: { id: 1 }, repository: { full_name: WAITING },
    check_run: { head_sha: head, status: "completed", conclusion: "success", pull_requests: [{ number: 1, head: { sha: head } }] },
  });
  const claim = await settled(WAITING, 1, ended.history.length + 1);
  return { head, whileWaiting, claim, deployed: (await managers()).slice(before), asked: model.decisions.slice(asked).map((row) => row.id), pull: github.pull(WAITING, 1), misses: github.misses.slice(missed) };
});

test("a head whose CI runs after the first post ends its manager while it waits, and the check event wakes a fresh one that judges it and posts the final verdict", async () => {
  const { head, whileWaiting, claim, deployed, asked, pull, misses } = await waiting();
  expect(misses).toEqual([]);
  expect(labelled(whileWaiting.writes)).toEqual([WAITING_LABEL]);
  expect(comments(whileWaiting.writes)).toEqual([expect.stringContaining("**Triage: In progress**\n\nTriage is waiting for CI to finish")]);
  expect(whileWaiting.asked).toBe(0);
  expect(whileWaiting.claim.status).toBe("ended");
  expect(whileWaiting.managers).toHaveLength(1);
  expect(isLiveDeployment(whileWaiting.managers[0]!.status)).toBe(false);
  expect(deployed).toHaveLength(2);
  expect(deployed.every((run) => !isLiveDeployment(run.status))).toBe(true);
  expect(asked).toContain("focused");
  expect(pull.labels).toEqual([VERDICT_LABELS.pass]);
  expect(pull.comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(claim).toMatchObject({ status: "ended" });
  expect(claim.history.at(-1)).toMatchObject({ head, runId: deployed[1]!.id });
  expect(await verdictsOf(WAITING, 1)).toEqual([expect.objectContaining({ run_id: deployed[1]!.id, head_sha: head, run_status: "completed" })]);
});
