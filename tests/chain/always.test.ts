// A held Do the inbox's "Always request review for this repository" lets Triage do on its own.
import { expect, test } from "bun:test";
import { allowTriageAutomation, approveHeldDo } from "../../apps/web/src/lib/hub-api.ts";
import type { Write } from "./github.ts";
import { chainStack, ALWAYS, sha, pullOf, once } from "./chain.ts";

const chain = chainStack();
const { github, pushed, until, settled, verdictsOf } = chain;

function reviewRequests(writes: readonly Write[]): Write[] {
  return writes.filter((write) => write.method === "POST" && write.path.endsWith("/requested_reviewers"));
}

/** As the inbox's "Always request review for this repository" does, while the workspace still asks before every action but posting. */
const alwaysAllowed = once(async function alwaysAllowed() {
  const { transport, tenantId } = chain.workspace;
  const missed = github.misses.length;
  await pushed(ALWAYS, pullOf(1, sha("always-1")));
  await settled(ALWAYS, 1);
  const [held] = await verdictsOf(ALWAYS, 1);
  const [step] = held!["dos"] as { effectId: string }[];
  await approveHeldDo(transport, tenantId, { runId: String(held!["run_id"]), repo: ALWAYS, number: 1, effectId: step!.effectId, kind: "request-review" });
  const automatic = await allowTriageAutomation(transport, tenantId, { repo: ALWAYS, source: "github", kind: "request-review", list: "pass" });
  await until("the approved review request", () => reviewRequests(github.writesTo(ALWAYS, 1))[0]);
  await settled(ALWAYS, 1, 2);
  await pushed(ALWAYS, pullOf(2, sha("always-2")));
  await settled(ALWAYS, 2);
  const [next] = await verdictsOf(ALWAYS, 2);
  return { held, automatic, next, first: github.writesTo(ALWAYS, 1), second: github.writesTo(ALWAYS, 2), misses: github.misses.slice(missed) };
});

test("Always runs the held Do once, and the next pull request in the repository gets it with nothing held", async () => {
  const { held, automatic, next, first, second, misses } = await alwaysAllowed();
  expect(misses).toEqual([]);
  expect(held).toMatchObject({ detail: { actions: [expect.objectContaining({ kind: "request-review", held: true })] } });
  expect(automatic).toContain("request-review");
  expect(reviewRequests(first)).toEqual([expect.objectContaining({ body: { reviewers: ["hubot"], team_reviewers: [] } })]);
  expect(next).toMatchObject({ detail: { actions: [expect.objectContaining({ kind: "request-review", status: "done" })] } });
  expect((next!["detail"] as { actions: { held?: true }[] }).actions[0]!.held).toBeUndefined();
  expect(reviewRequests(second)).toEqual([expect.objectContaining({ body: { reviewers: ["hubot"], team_reviewers: [] } })]);
});
