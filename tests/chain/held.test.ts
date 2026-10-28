// A Do the policy holds, approved through the hub.
import { expect, test } from "bun:test";
import { VERDICT_LABELS } from "@corbits/triage-contracts";
import { approveHeldDo } from "../../apps/web/src/lib/hub-api.ts";
import { HELD, github, workspace, sha, pullOf, pushed, until, settled, verdictsOf, labelled, once } from "./chain.ts";

const approved = once(async function approved() {
  const head = sha("held-1");
  const missed = github.misses.length;
  await pushed(HELD, pullOf(1, head));
  await settled(HELD, 1);
  const writes = [...github.writesTo(HELD, 1)];
  const [verdict] = await verdictsOf(HELD, 1);
  return { head, writes, verdict, misses: github.misses.slice(missed) };
});

test("a Do the policy does not run on its own is held", async () => {
  const { head, writes, verdict, misses } = await approved();
  expect(misses).toEqual([]);
  expect(verdict).toMatchObject({ head_sha: head, dos: [{ list: "pass" }], detail: { actions: [expect.objectContaining({ list: "pass", kind: "assign", target: { users: ["octocat"] }, held: true })] } });
  expect(writes.some((write) => write.path.endsWith("/assignees"))).toBe(false);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
});

test("a held Do approved through the hub runs once on the pull request", async () => {
  const { verdict } = await approved();
  // The verdict's one Do is the held assign, whose effect id its recorded Dos keep.
  const [held] = verdict!["dos"] as { effectId: string }[];
  await approveHeldDo(workspace.transport, workspace.tenantId, { runId: String(verdict!["run_id"]), repo: HELD, number: 1, effectId: held!.effectId, kind: "assign" });
  await until("the assignment", () => github.writesTo(HELD, 1).find((write) => write.path.endsWith("/assignees")));
  await settled(HELD, 1, 2);
  expect(github.writesTo(HELD, 1).filter((write) => write.path.endsWith("/assignees"))).toEqual([expect.objectContaining({ method: "POST", body: { assignees: ["octocat"] } })]);
});
