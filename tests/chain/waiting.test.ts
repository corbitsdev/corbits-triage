// A head whose CI runs after the first post, kept by one manager until its final verdict.
import { expect, test } from "bun:test";
import { VERDICT_LABELS, WAITING_LABEL } from "@corbits/triage-contracts";
import { deliver } from "./stack.ts";
import { chainStack, WAITING, isLiveDeployment, sha, pullOf, comments, labelled, once } from "./chain.ts";

const chain = chainStack();
const { github, model, pushed, until, claimOf, managers, settled, verdictsOf } = chain;

const waiting = once(async function waiting() {
  const head = sha("waiting-1");
  const [before, asked, missed] = [(await managers()).length, model.decisions.length, github.misses.length];
  github.setChecks(WAITING, head, [{ name: "build", status: "in_progress", conclusion: null }]);
  await pushed(WAITING, pullOf(1, head));
  await until("the Waiting label", () => labelled(github.writesTo(WAITING, 1)).includes(WAITING_LABEL) || undefined);
  const whileWaiting = { writes: [...github.writesTo(WAITING, 1)], claim: (await claimOf(WAITING, 1))!, managers: (await managers()).slice(before), asked: model.decisions.length - asked };
  github.setChecks(WAITING, head, [{ name: "build", status: "completed", conclusion: "success" }]);
  await deliver(chain.hub, chain.workspace, "check_run", {
    action: "completed", installation: { id: 1 }, repository: { full_name: WAITING },
    check_run: { head_sha: head, status: "completed", conclusion: "success", pull_requests: [{ number: 1, head: { sha: head } }] },
  });
  const claim = await settled(WAITING, 1, whileWaiting.claim.history.length + 2);
  return { head, whileWaiting, claim, deployed: (await managers()).slice(before), asked: model.decisions.slice(asked).map((row) => row.id), pull: github.pull(WAITING, 1), misses: github.misses.slice(missed) };
});

test("a head whose CI runs after the first post keeps one manager, which judges it once CI finished, posts the final verdict and only then ends", async () => {
  const { head, whileWaiting, claim, deployed, asked, pull, misses } = await waiting();
  expect(misses).toEqual([]);
  expect(labelled(whileWaiting.writes)).toEqual([WAITING_LABEL]);
  expect(comments(whileWaiting.writes)).toEqual([expect.stringContaining("**Triage: In progress**\n\nTriage is waiting for CI to finish")]);
  expect(whileWaiting.asked).toBe(0);
  expect(whileWaiting.claim).toMatchObject({ status: "live", runId: whileWaiting.managers[0]!.id });
  expect(whileWaiting.managers.map((run) => run.status)).toEqual(["running"]);
  expect(deployed.map((run) => run.id)).toEqual([whileWaiting.managers[0]!.id]);
  expect(isLiveDeployment(deployed[0]!.status)).toBe(false);
  expect(new Set(claim.history.map((pass) => pass.runId))).toEqual(new Set([deployed[0]!.id]));
  expect(asked).toContain("focused");
  expect(pull.labels).toEqual([VERDICT_LABELS.pass]);
  expect(pull.comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(claim).toMatchObject({ status: "ended" });
  expect(claim.history.at(-1)!.head).toBe(head);
  expect(await verdictsOf(WAITING, 1)).toEqual([expect.objectContaining({ run_id: deployed[0]!.id, head_sha: head, run_status: "completed" })]);
});
