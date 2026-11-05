// Requires PostgreSQL at localhost:5432 (docs/DEV.md). Checks the rules in docs/INVARIANTS.md after every sequence of
// events on a pull request, each on a pull request of its own, so no reset is needed between them.
import { afterAll, expect, mock, setDefaultTimeout, test } from "bun:test";
import { errorText } from "@corbits/common";
import { isTriageComment } from "@corbits/github-reads";
import { HTML_MARKERS, VERDICT_LABELS, emptyPack } from "@corbits/triage-contracts";
import { CODE_REVIEW_RUNNING } from "@corbits/triage-workflows/logic/render";
import { labelled, OWNER, pullOf, sha, type Write } from "../chain/github.ts";
import { LETTERS, open, play, settle, walk, type Letter, type Played } from "./events.ts";
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
const LABELLING: typeof PACK = { ...PACK, actions: { ...PACK.actions, when: ["opened"], pass: [{ do: "labels", target: { from: "list", labels: ["shipit"] } }] } };
const labelling = await modelStack(`${OWNER}/labelling`, { pack: LABELLING, automatic: ["labels", "comment"] });
const labellingReviewed = await modelStack(`${OWNER}/labelling-reviewed`, { pack: LABELLING, automatic: ["labels", "comment"], review: "dies-after-mail" });
const UNLABELLED: typeof PACK = { ...PACK, repo: `${OWNER}/unlabelled` };
delete UNLABELLED.labels;
const unlabelled = await modelStack(UNLABELLED.repo, { pack: UNLABELLED, automatic: ["labels", "comment"] });
const labelsOnly = await modelStack(`${OWNER}/labels-only`, { pack: { ...PACK, repo: `${OWNER}/labels-only` }, automatic: ["labels"] });
const ungranted = await modelStack(`${OWNER}/ungranted`, { pack: { ...PACK, repo: `${OWNER}/ungranted` }, automatic: [] });
const MERGING: typeof PACK = { ...PACK, repo: `${OWNER}/merging`, actions: { ...PACK.actions, fail: [{ do: "merge" }] } };
const merging = await modelStack(MERGING.repo, { pack: MERGING, automatic: ["labels", "comment", "merge"] });
setDefaultTimeout(5 * 60_000);
afterAll(async () => {
  await stack.stop();
  await neverReady.stop();
  await diesAfterMail.stop();
  await labelling.stop();
  await labellingReviewed.stop();
  await unlabelled.stop();
  await labelsOnly.stop();
  await ungranted.stop();
  await merging.stop();
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
])("with code review on and its run %s, a mail on the head after its verdict keeps the verdict and deploys the review once more", async (_fault, model) => {
  const missed = model.github.misses.length;
  const pull = await open(model, ++pulls);
  await settle(model, pull);
  expect(await play(model, pull, "edit")).toBe(true);
  await settle(model, pull);
  expect([...(await broken(model, pull, missed)), ...verdictKept(model, pull)]).toEqual([]);
  expect(model.reviewRuns(pull.number)).toHaveLength(2);
});

test(`${WALKS} seeded walks of ${WALK_LENGTH} events keep the rules`, async () => {
  const found: string[] = [];
  for (let seed = 0; seed < WALKS; seed++) {
    const { played, breaks } = await check(walk(seed, WALK_LENGTH));
    found.push(...breaks.map((rule) => `seed ${seed}, ${replayOf(played)}: ${rule}`));
  }
  expect(found).toEqual([]);
});

/** Each Triage comment written, in order, and the verdict labels added before the first that is not in progress. */
function commentsAndEarlyLabels(writes: readonly Write[]): { comments: string[]; early: string[] } {
  const comments: string[] = [];
  const early: string[] = [];
  for (const { method, path, body } of writes) {
    const text = (body as { body?: unknown } | null)?.body;
    if ((method === "POST" || method === "PATCH") && path.includes("/comments") && typeof text === "string" && isTriageComment(text) && !HTML_MARKERS.isSuperseded(text)) comments.push(text);
    const verdictUp = comments.some((comment) => !comment.includes("**Triage: In progress**"));
    if (!verdictUp && method === "POST" && path.endsWith("/labels")) early.push(...(body as { labels: string[] }).labels.filter((label) => Object.values(VERDICT_LABELS).includes(label)));
  }
  return { comments, early };
}

test("with code review on, the in-progress comment shows the verdict's results while the review runs, and the verdict label waits for the verdict", async () => {
  const missed = diesAfterMail.github.misses.length;
  const pull = await open(diesAfterMail, ++pulls);
  await play(diesAfterMail, pull, "ci-success");
  await settle(diesAfterMail, pull);
  const { comments, early } = commentsAndEarlyLabels(diesAfterMail.writes(pull.number));
  const running = comments.find((comment) => comment.includes("**Triage: In progress**") && comment.includes(CODE_REVIEW_RUNNING));
  const verdictBody = comments.at(-1)!.split("\n\n").slice(1).join("\n\n");
  expect(running).toContain(verdictBody);
  expect(early).toEqual([]);
  expect(await broken(diesAfterMail, pull, missed)).toEqual([]);
});

function shipits(model: typeof stack, number: number): string[] {
  return labelled(model.writes(number)).filter((label) => label === "shipit");
}

test("an action on opened runs once when CI finishes after the open waited for it", async () => {
  const pull = await open(labelling, ++pulls);
  await labelling.drain();
  await play(labelling, pull, "ci-success");
  await labelling.drain();
  await play(labelling, pull, "ci-success");
  await labelling.drain();
  expect(shipits(labelling, pull.number)).toEqual(["shipit"]);
});

test("with code review on, an action on opened runs once when the pass after CI finishes still waits for the review", async () => {
  const pull = await open(labellingReviewed, ++pulls);
  await labellingReviewed.drain();
  await play(labellingReviewed, pull, "ci-success");
  await labellingReviewed.drain();
  await play(labellingReviewed, pull, "ci-success");
  await labellingReviewed.drain();
  expect(shipits(labellingReviewed, pull.number)).toEqual(["shipit"]);
});

test("with labels off, Triage adds no label and takes an earlier verdict label off once", async () => {
  const number = ++pulls;
  const pull: Played = { number, heads: [sha(`${number}-0`)], draft: false };
  await unlabelled.open({ ...pullOf(number, pull.heads[0]!), labels: [VERDICT_LABELS.pass] });
  await settle(unlabelled, pull);
  await play(unlabelled, pull, "push");
  await settle(unlabelled, pull);
  const writes = unlabelled.writes(number);
  const removed = writes.filter((write) => write.method === "DELETE" && write.path.includes("/labels/")).map((write) => decodeURIComponent(write.path.split("/labels/")[1]!));
  expect(labelled(writes)).toEqual([]);
  expect(removed).toEqual([VERDICT_LABELS.pass]);
});

test("without the comment, a pull request closed before its verdict loses Triage's labels", async () => {
  const number = ++pulls;
  const pull: Played = { number, heads: [sha(`${number}-0`)], draft: false };
  await labelsOnly.open({ ...pullOf(number, pull.heads[0]!), labels: ["Triage: Waiting for CI"] });
  await labelsOnly.drain();
  await play(labelsOnly, pull, "close");
  await settle(labelsOnly, pull);
  const writes = labelsOnly.writes(number);
  const removed = writes.filter((write) => write.method === "DELETE" && write.path.includes("/labels/")).map((write) => decodeURIComponent(write.path.split("/labels/")[1]!));
  expect(labelled(writes)).toEqual([]);
  expect(removed).toEqual(["Triage: Waiting for CI"]);
});

test("without the comment, a pull request closed after its verdict keeps the verdict label", async () => {
  const pull = await open(labelsOnly, ++pulls);
  await settle(labelsOnly, pull);
  const [verdict] = labelled(labelsOnly.writes(pull.number));
  await play(labelsOnly, pull, "close");
  await settle(labelsOnly, pull);
  expect(verdict).toBeDefined();
  expect(labelsOnly.github.pull(labelsOnly.repo, pull.number).labels).toContain(verdict!);
});

test("without any posting grant, a pull request closed before its verdict is not written to", async () => {
  const number = ++pulls;
  const pull: Played = { number, heads: [sha(`${number}-0`)], draft: false };
  await ungranted.open({ ...pullOf(number, pull.heads[0]!), labels: ["Triage: Waiting for CI"] });
  await ungranted.drain();
  await play(ungranted, pull, "close");
  await settle(ungranted, pull);
  expect(ungranted.writes(number)).toEqual([]);
});

test("a merge waits while a reviewer requests changes", async () => {
  const number = ++pulls;
  const pull: Played = { number, heads: [sha(`${number}-0`)], draft: false };
  const review = { id: 1, user: { login: "maya", type: "User" }, state: "CHANGES_REQUESTED", body: "", commit_id: pull.heads[0]!, comments: [] };
  await merging.open({ ...pullOf(number, pull.heads[0]!), reviews: [review] });
  await settle(merging, pull);
  const writes = merging.writes(number);
  expect(writes.filter((write) => write.path.endsWith("/merge"))).toEqual([]);
  expect(merging.github.misses.filter((miss) => miss.endsWith("/merge"))).toEqual([]);
  expect(commentsAndEarlyLabels(writes).comments.at(-1)).toContain("Changes are requested by maya.");
});
