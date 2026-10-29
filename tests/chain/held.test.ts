// A Do the policy holds, approved through the hub.
import { expect, test } from "bun:test";
import { TRIAGE_ROLE, VERDICT_LABELS } from "@corbits/triage-contracts";
import { approveHeldDo, saveAutomationMode, saveRepoSettings } from "../../apps/web/src/lib/hub-api.ts";
import { chainStack, HELD, once } from "./chain.ts";
import { sha, pullOf, labelled } from "./github.ts";

const chain = chainStack();
const { github, pushed, until, rows, settled, verdictsOf } = chain;

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
  await approveHeldDo(chain.workspace.transport, chain.workspace.tenantId, { runId: String(verdict!["run_id"]), repo: HELD, number: 1, effectId: held!.effectId, kind: "assign" });
  await until("the assignment", () => github.writesTo(HELD, 1).find((write) => write.path.endsWith("/assignees")));
  await settled(HELD, 1, 2);
  expect(github.writesTo(HELD, 1).filter((write) => write.path.endsWith("/assignees"))).toEqual([expect.objectContaining({ method: "POST", body: { assignees: ["octocat"] } })]);
});

const followed = once(async function followed() {
  const head = sha("held-2");
  const missed = github.misses.length;
  await saveAutomationMode(chain.workspace.transport, chain.workspace.tenantId, "policy");
  await pushed(HELD, pullOf(2, head));
  await settled(HELD, 2);
  const [verdict] = await verdictsOf(HELD, 2);
  return { head, writes: github.writesTo(HELD, 2), verdict, misses: github.misses.slice(missed) };
});

test("under policy automation, the next pass runs a Do the policy uses on its own, with nothing held", async () => {
  const { head, writes, verdict, misses } = await followed();
  expect(misses).toEqual([]);
  expect(verdict).toMatchObject({ head_sha: head });
  const { actions } = verdict!["detail"] as { actions: { kind: string; held?: boolean }[] };
  expect(actions).toEqual([expect.objectContaining({ list: "pass", kind: "assign", target: { users: ["octocat"] } })]);
  expect(actions[0]!.held).not.toBe(true);
  expect(writes.filter((write) => write.path.endsWith("/assignees"))).toEqual([expect.objectContaining({ method: "POST", body: { assignees: ["octocat"] } })]);
});

/** What the pr-triage role holds on `repo`. */
async function triageGrantsOn(repo: string): Promise<string[]> {
  const found = await rows(`select g.resource from "grant" g join role r on r.id = g.role_id where r.name = '${TRIAGE_ROLE}' and g.resource like 'triage-do:%:${repo}' order by g.resource`);
  return found.map((row) => String(row["resource"]));
}

const switchedOff = once(async function switchedOff() {
  await followed();
  const before = await triageGrantsOn(HELD);
  await saveRepoSettings(chain.workspace.transport, chain.workspace.tenantId, HELD, "github", { enabled: false });
  return { before, after: await triageGrantsOn(HELD) };
});

test("switching a repository off takes back everything Triage did there on its own", async () => {
  const { before, after } = await switchedOff();
  expect(before).toEqual([`triage-do:assign:${HELD}`, `triage-do:comment:${HELD}`, `triage-do:labels:${HELD}`]);
  expect(after).toEqual([]);
});
