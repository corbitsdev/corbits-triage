import { expect, test } from "bun:test";
import { MAX_MERGE_STATES } from "@corbits/triage-contracts";
import type { MergeState, PrItem } from "./hub-api.ts";
import { knownMergeStates, mergeStateReads } from "./merge-states.ts";

const BLOCKED: MergeState = { number: 1, mergeable: true, mergeableState: "blocked", reviewDecision: "REVIEW_REQUIRED" };

test("a read that failed says nothing, even of what an earlier read answered", () => {
  expect(knownMergeStates([{ repo: "acme/widgets", source: "github" }], [{ data: [BLOCKED], isError: true }]).size).toBe(0);
});

test("a repository with more passes than the hub answers for at once is read in batches that cover every pass", () => {
  const passes = Array.from({ length: 250 }, (_, i) => ({ repo: "acme/widgets", source: "github", number: 250 - i, closed: false, verdict: "pass" }) as PrItem);
  const reads = mergeStateReads(passes);
  expect(reads.every((read) => read.numbers.length <= MAX_MERGE_STATES)).toBe(true);
  expect(reads.flatMap((read) => read.numbers)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
});

test("the same repository name on two hosts is not read as one batch", () => {
  const items = [
    { repo: "acme/widgets", source: "github", number: 2, closed: false, verdict: "pass" },
    { repo: "acme/widgets", source: "bitbucket-datacenter", number: 2, closed: false, verdict: "pass" },
  ] as PrItem[];
  expect(mergeStateReads(items)).toEqual([
    { repo: "acme/widgets", source: "github", batch: 0, numbers: [2] },
    { repo: "acme/widgets", source: "bitbucket-datacenter", batch: 0, numbers: [2] },
  ]);
});
