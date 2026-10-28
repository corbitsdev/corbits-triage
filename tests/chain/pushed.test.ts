// Pushes while the manager is up and after it stopped.
import { expect, test } from "bun:test";
import { chainStack, PUSHED, sha, pullOf, once } from "./chain.ts";

const { github, pushed, until, rows, claimOf, managers, settled } = chainStack();

const pushedAgain = once(async function pushedAgain() {
  const [first, second, third] = [sha("pushed-1"), sha("pushed-2"), sha("pushed-3")];
  const [before, missed] = [(await managers()).length, github.misses.length];
  // The manager's pass reads the files, so holding them keeps it up while the second push arrives.
  const release = github.hold(PUSHED, 1);
  await pushed(PUSHED, pullOf(1, first));
  await until("the manager to claim the pull request", async () => (await claimOf(PUSHED, 1))?.status === "live" || undefined);
  await pushed(PUSHED, pullOf(1, second), "synchronize");
  await until("the second push to be recorded", async () => {
    const [row] = await rows(`select count(*)::int as recorded from corbits_triage.manager_state where kind = 'event' and key like 'evt:github:${PUSHED}#1:%'`);
    return Number(row!["recorded"]) >= 2 || undefined;
  });
  release();
  const alive = await settled(PUSHED, 1, 2);
  const afterTwo = (await managers()).slice(before);
  await pushed(PUSHED, pullOf(1, third), "synchronize");
  const claim = await settled(PUSHED, 1, alive.history.length + 1);
  return { second, third, alive, afterTwo, claim, deployed: (await managers()).slice(before), misses: github.misses.slice(missed) };
});

test("a push while the manager is up is mailed to it, and one after it stopped deploys the next, never two at once", async () => {
  const { second, third, alive, afterTwo, claim, deployed, misses } = await pushedAgain();
  expect(misses).toEqual([]);
  expect(afterTwo).toHaveLength(1);
  expect(new Set(alive.history.map((pass) => pass.runId))).toEqual(new Set([afterTwo[0]!.id]));
  expect(alive.history.at(-1)!.head).toBe(second);
  expect(deployed).toHaveLength(2);
  expect(claim.history.at(-1)).toMatchObject({ head: third, runId: deployed[1]!.id });
  expect(deployed[1]!.createdAt.getTime()).toBeGreaterThanOrEqual(new Date(alive.history.at(-1)!.doneAt).getTime() - 1_000);
});
