// A policy whose rules need the judge.
import { expect, test } from "bun:test";
import { VERDICT_LABELS } from "@corbits/triage-contracts";
import { chainStack, JUDGED, once } from "./chain.ts";
import { sha, pullOf, comments, labelled } from "./github.ts";

const { github, model, pushed, settled, verdictsOf } = chainStack();

const judged = once(async function judged() {
  const head = sha("judged-1");
  const [asked, missed] = [model.decisions.length, github.misses.length];
  await pushed(JUDGED, pullOf(1, head));
  await settled(JUDGED, 1);
  return { head, asked: model.decisions.slice(asked).map((row) => row.id), writes: github.writesTo(JUDGED, 1), pull: github.pull(JUDGED, 1), misses: github.misses.slice(missed) };
});

test("a policy that needs the judge deploys it and posts the judge's verdict once", async () => {
  const { head, asked, writes, pull, misses } = await judged();
  expect(misses).toEqual([]);
  expect(asked).toContain("focused");
  expect(comments(writes)).toEqual([expect.stringContaining("**Triage: In progress**\n\nTriage is waiting for the decision model's answer")]);
  expect(pull.comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(labelled(writes)).toEqual([VERDICT_LABELS.pass]);
  // The pass that deployed the judge reported no verdict, so only the judge's is recorded.
  expect(await verdictsOf(JUDGED, 1)).toEqual([expect.objectContaining({ head_sha: head, state: "ready-monitoring" })]);
});

/** Forty files of 400 long lines each: the rules output the manager attaches for the judge is over stock's 1 MiB inline limit. */
const large = once(async function large() {
  const head = sha("judged-large-1");
  const line = `+export const value = "${"x".repeat(100)}";\n`;
  const files = Array.from({ length: 40 }, (_, i) => ({ filename: `src/file-${i}.ts`, status: "added", additions: 400, deletions: 0, patch: `@@ -0,0 +1,400 @@\n${line.repeat(400)}` }));
  const asked = model.decisions.length;
  await pushed(JUDGED, { ...pullOf(2, head), files });
  await settled(JUDGED, 2);
  return { head, asked: model.decisions.slice(asked).map((row) => row.id), pull: github.pull(JUDGED, 2) };
});

test("a pull request whose rules output is over 1 MiB is judged and its verdict posted once", async () => {
  const { head, asked, pull } = await large();
  expect(asked).toContain("focused-slice-001");
  expect(pull.comments.map((comment) => comment.body)).toEqual([expect.stringContaining("**Triage: Pass**")]);
  expect(await verdictsOf(JUDGED, 2)).toEqual([expect.objectContaining({ head_sha: head, state: "ready-monitoring" })]);
});
