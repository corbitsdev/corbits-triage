// Requires PostgreSQL at localhost:5432 (docs/DEV.md). Checks the rules in docs/INVARIANTS.md after every sequence of
// events on a pull request, each on a pull request of its own, so no reset is needed between them.
import { afterAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import { errorText } from "@corbits/common";
import { emptyPack } from "@corbits/triage-contracts";
import { OWNER } from "../chain/github.ts";
import { LETTERS, open, play, settle, walk, type Letter } from "./events.ts";
import { broken, verdictKept } from "./rules.ts";
import { MANAGER_RELEASE, modelStack, REVIEW_RELEASE } from "./stack.ts";

/** Every sequence of up to this many events after the open is played and checked; one with an event that changes nothing is not extended. */
const LENGTH = 2;
const WALKS = 300;
const WALK_LENGTH = 10;
/** With code review on, every sequence of up to this many events. */
const REVIEW_LENGTH = 1;

mock.module(new URL("../../packages/triage-manager/src/release.json", import.meta.url).pathname, function published() {
  return { default: { github: { manager: MANAGER_RELEASE, codeReview: REVIEW_RELEASE } } };
});

const REPO = `${OWNER}/model`;
// Under `ask`, the pr-triage role holds only posting: its labels and its comment.
const PACK = { ...emptyPack(REPO), checks: { "max-files-changed": { enabled: true }, "ci-green": { enabled: true } } };
const stack = await modelStack(REPO, { pack: PACK, automatic: ["labels", "comment"] });
const neverReady = await modelStack(REPO, { pack: PACK, automatic: ["labels", "comment"], review: "fails-before-ready" });
const diesAfterMail = await modelStack(REPO, { pack: PACK, automatic: ["labels", "comment"], review: "dies-after-mail" });
setDefaultTimeout(5 * 60_000);
afterAll(async () => {
  await stack.stop();
  await neverReady.stop();
  await diesAfterMail.stop();
});

let pulls = 0;

type Checked = { played: Letter[]; breaks: string[] };

/** Plays `letters` after an open on a pull request of its own on `model`, each that changes nothing left out, and settles it. */
async function check(letters: readonly Letter[], model = stack): Promise<Checked> {
  const missed = model.github.misses.length;
  const played: Letter[] = [];
  try {
    const pull = await open(model, ++pulls);
    for (const letter of letters) if (await play(model, pull, letter)) played.push(letter);
    await settle(model, pull);
    return { played, breaks: await broken(model, pull, missed) };
  } catch (err) {
    // The queue may hold the failed sequence's mail; the next sequence starts from none.
    model.queue.length = 0;
    return { played: [...letters], breaks: [`threw after ${played.length} events: ${errorText(err)}`] };
  }
}

function replayOf(letters: readonly Letter[]): string {
  return ["open", ...letters].join(" ");
}

/** The rules each sequence of up to `length` events after an open on `model` breaks. */
async function everySequence(length: number, model = stack): Promise<string[]> {
  const found: string[] = [];
  let level: Letter[][] = [[]];
  for (let size = 0; size <= length; size++) {
    const next: Letter[][] = [];
    for (const letters of level) {
      const checked = await check(letters, model);
      found.push(...checked.breaks.map((rule) => `${replayOf(letters)}: ${rule}`));
      // A sequence with an event that changed nothing is a shorter one already played, and so is every sequence after it.
      if (size < length && checked.played.length === letters.length) next.push(...LETTERS.map((letter) => [...letters, letter]));
    }
    level = next;
  }
  return found;
}

test(`every sequence up to ${LENGTH} events after an open keeps the rules`, async () => {
  expect(await everySequence(LENGTH)).toEqual([]);
});

test.each([
  ["failing before it is ready", neverReady],
  ["dying after it takes its mail", diesAfterMail],
])(`with code review on and its run %s, every sequence up to ${REVIEW_LENGTH} event after an open keeps the rules`, async (_fault, model) => {
  expect(await everySequence(REVIEW_LENGTH, model)).toEqual([]);
  expect(model.reviewsRead()).not.toEqual([]);
});

// The edit stands in for any mail on the same head after its verdict, as the hub's requeue once the base branch moved.
test.each([
  ["failing before it is ready", neverReady],
  ["dying after it takes its mail", diesAfterMail],
])("with code review on and its run %s, a mail on the head after its verdict keeps the verdict and deploys no other review", async (_fault, model) => {
  const missed = model.github.misses.length;
  const pull = await open(model, ++pulls);
  await settle(model, pull);
  expect(await play(model, pull, "edit")).toBe(true);
  await settle(model, pull);
  expect([...(await broken(model, pull, missed)), ...verdictKept(model, pull)]).toEqual([]);
  expect(model.reviewRuns(pull.number)).toHaveLength(1);
});

test(`${WALKS} seeded walks of ${WALK_LENGTH} events keep the rules`, async () => {
  const found: string[] = [];
  for (let seed = 0; seed < WALKS; seed++) {
    const { played, breaks } = await check(walk(seed, WALK_LENGTH));
    found.push(...breaks.map((rule) => `seed ${seed}, ${replayOf(played)}: ${rule}`));
  }
  expect(found).toEqual([]);
});
