// Requires PostgreSQL at localhost:5432 (docs/DEV.md). Checks the rules in docs/INVARIANTS.md after every sequence of
// events on a pull request, each on a pull request of its own, so no reset is needed between them.
import { afterAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import { emptyPack } from "@corbits/triage-contracts";
import { OWNER } from "../chain/github.ts";
import { LETTERS, open, play, settle, walk, type Letter } from "./events.ts";
import { broken } from "./rules.ts";
import { MANAGER_RELEASE, modelStack } from "./stack.ts";

/** Every sequence up to this many events after the open is played, less those with an event that changes nothing. */
const LENGTH = 2;
const WALKS = 300;
const WALK_LENGTH = 10;

mock.module(new URL("../../packages/triage-manager/src/release.json", import.meta.url).pathname, function published() {
  return { default: { github: { manager: MANAGER_RELEASE } } };
});

const REPO = `${OWNER}/model`;
// Under `ask`, the pr-triage role holds only posting: its labels and its comment.
const stack = await modelStack(REPO, { pack: { ...emptyPack(REPO), checks: { "max-files-changed": { enabled: true }, "ci-green": { enabled: true } } }, automatic: ["labels", "comment"] });
setDefaultTimeout(5 * 60_000);
afterAll(() => stack.stop());

let pulls = 0;

type Checked = { played: Letter[]; breaks: string[] };

/** Plays `letters` after an open on a pull request of its own, each that changes nothing left out, and settles it. */
async function check(letters: readonly Letter[]): Promise<Checked> {
  const missed = stack.github.misses.length;
  const played: Letter[] = [];
  try {
    const pull = await open(stack, ++pulls);
    for (const letter of letters) if (await play(stack, pull, letter)) played.push(letter);
    await settle(stack, pull);
    return { played, breaks: await broken(stack, pull, missed) };
  } catch (err) {
    // The queue may hold the failed sequence's mail; the next sequence starts from none.
    stack.queue.length = 0;
    return { played: [...letters], breaks: [`threw after ${played.length} events: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

function replayOf(letters: readonly Letter[]): string {
  return ["open", ...letters].join(" ");
}

test(`every sequence up to ${LENGTH} events after an open keeps the rules`, async () => {
  const found: string[] = [];
  let level: Letter[][] = [[]];
  for (let size = 0; size <= LENGTH; size++) {
    const next: Letter[][] = [];
    for (const letters of level) {
      const checked = await check(letters);
      // A sequence with an event that changed nothing is a shorter one already played, and so is every sequence after it.
      if (checked.played.length < letters.length) continue;
      found.push(...checked.breaks.map((rule) => `${replayOf(letters)}: ${rule}`));
      if (size < LENGTH) next.push(...LETTERS.map((letter) => [...letters, letter]));
    }
    level = next;
  }
  expect(found).toEqual([]);
});

test(`${WALKS} seeded walks of ${WALK_LENGTH} events keep the rules`, async () => {
  const found: string[] = [];
  for (let seed = 0; seed < WALKS; seed++) {
    const { played, breaks } = await check(walk(seed, WALK_LENGTH));
    found.push(...breaks.map((rule) => `seed ${seed}, ${replayOf(played)}: ${rule}`));
  }
  expect(found).toEqual([]);
});
