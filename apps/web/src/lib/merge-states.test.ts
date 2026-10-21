import { expect, test } from "bun:test";
import type { MergeState } from "./hub-api.ts";
import { knownMergeStates } from "./merge-states.ts";

const BLOCKED: MergeState = { number: 1, mergeable: true, mergeableState: "blocked", reviewDecision: "REVIEW_REQUIRED" };

test("a read that failed says nothing, even of what an earlier read answered", () => {
  expect(knownMergeStates(["acme/widgets"], [{ data: [BLOCKED], isError: true }]).size).toBe(0);
});
