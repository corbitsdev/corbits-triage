// A manager whose wake mail failed.
import { expect, test } from "bun:test";
import { chainStack, UNWOKEN, isLiveDeployment, sha, pullOf, comments, once } from "./chain.ts";

const { github, pushed, eachRunEvent, until, rows, managers, settled } = chainStack();

// The listener waits two minutes for each manager's key before its wake mail fails, for the first and the one it deploys in
// its place; stock then stops each within its 30-second cancel grace.
const UNWOKEN_MS = 8 * 60_000;

const INLINE = "inline:";

/** The managers the listener's unwoken and unwokenAgain steps cancelled, as their outputs, which the hub reads back inline, name them. */
async function unwokenCancelled(): Promise<{ runId: string; reason: string }[]> {
  const cancelled: { runId: string; reason: string }[] = [];
  await eachRunEvent(function collect(_runId, { type, body }) {
    if (type !== "StepCompleted" || (body["stepId"] !== "unwoken" && body["stepId"] !== "unwokenAgain")) return;
    const { ref } = body["output"] as { ref: string };
    if (!ref.startsWith(INLINE)) throw new Error(`unwoken's output is not inline: ${ref}`);
    cancelled.push(...(JSON.parse(ref.slice(INLINE.length)) as { cancelled: { runId: string; reason: string }[] }).cancelled);
  });
  return cancelled;
}

/** Keeps every run deployed from now on from recording its public key, as a sidecar that never acks its deploy would. */
async function refuseKeys(): Promise<void> {
  await rows("create function chain_refuse_key() returns trigger language plpgsql as $$ begin new.public_key := null; return new; end $$");
  await rows(`create trigger chain_refuse_key before update of public_key on workflow_run for each row when (new.created_at > '${new Date().toISOString()}') execute function chain_refuse_key()`);
}

async function acceptKeys(): Promise<void> {
  await rows("drop trigger if exists chain_refuse_key on workflow_run");
  await rows("drop function if exists chain_refuse_key()");
}

const unwoken = once(async function unwoken() {
  const [first, second] = [sha("unwoken-1"), sha("unwoken-2")];
  const [before, missed] = [(await managers()).length, github.misses.length];
  await refuseKeys();
  let cancelled: { id: string; status: string }[];
  try {
    await pushed(UNWOKEN, pullOf(1, first));
    cancelled = await until("the unwoken manager and the one deployed in its place to end", async function ended() {
      const deployed = (await managers()).slice(before);
      return deployed.length === 2 && deployed.every((run) => !isLiveDeployment(run.status)) ? deployed : undefined;
    }, UNWOKEN_MS);
  } finally {
    await acceptKeys();
  }
  const whileUnwoken = [...github.writesTo(UNWOKEN, 1)];
  await pushed(UNWOKEN, pullOf(1, second), "synchronize");
  const claim = await settled(UNWOKEN, 1);
  return { second, cancelled, whileUnwoken, claim, unwoken: await unwokenCancelled(), deployed: (await managers()).slice(before), writes: github.writesTo(UNWOKEN, 1), misses: github.misses.slice(missed) };
});

test("a manager whose wake mail failed is cancelled, as is the one deployed in its place, and the next event deploys a fresh one that posts the verdict", async () => {
  const { second, cancelled, whileUnwoken, claim, unwoken: reported, deployed, writes, misses } = await unwoken();
  expect(misses).toEqual([]);
  expect(cancelled.map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
  expect(whileUnwoken).toEqual([]);
  expect(reported).toEqual(cancelled.map((run) => ({ runId: run.id, reason: expect.stringContaining("public key") })));
  expect(deployed.map((run) => run.id)).toEqual([...cancelled.map((run) => run.id), claim.history.at(-1)!.runId]);
  expect(claim).toMatchObject({ status: "ended", history: [{ head: second }] });
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: Pass**")]);
});
