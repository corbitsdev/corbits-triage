// A head held for CI.
import { expect, test } from "bun:test";
import { VERDICT_LABELS, WAITING_LABEL } from "@corbits/triage-contracts";
import { deliver } from "./stack.ts";
import { WAITING, github, hub, workspace, sha, pullOf, pushed, settled, comments, labelled, once } from "./chain.ts";

const waiting = once(async function waiting() {
  const head = sha("waiting-1");
  const missed = github.misses.length;
  github.setChecks(WAITING, head, [{ name: "build", status: "in_progress", conclusion: null }]);
  await pushed(WAITING, pullOf(1, head));
  const held = await settled(WAITING, 1);
  const whileWaiting = [...github.writesTo(WAITING, 1)];
  github.setChecks(WAITING, head, [{ name: "build", status: "completed", conclusion: "success" }]);
  await deliver(hub, workspace, "check_run", {
    action: "completed", installation: { id: 1 }, repository: { full_name: WAITING },
    check_run: { head_sha: head, status: "completed", conclusion: "success", pull_requests: [{ number: 1, head: { sha: head } }] },
  });
  const claim = await settled(WAITING, 1, held.history.length + 1);
  return { head, whileWaiting, claim, pull: github.pull(WAITING, 1), misses: github.misses.slice(missed) };
});

test("a head held for CI is marked waiting, and its check run's completion settles it", async () => {
  const { head, whileWaiting, claim, pull, misses } = await waiting();
  expect(misses).toEqual([]);
  expect(labelled(whileWaiting)).toEqual([WAITING_LABEL]);
  expect(comments(whileWaiting)).toEqual([]);
  expect(pull.labels).toEqual([VERDICT_LABELS.pass]);
  expect(pull.comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(claim.status).toBe("ended");
  expect(claim.history.at(-1)!.head).toBe(head);
});
