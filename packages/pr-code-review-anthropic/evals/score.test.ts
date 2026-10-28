import { expect, test } from "bun:test";
import type { CaseKey } from "./cases.js";
import { scoreCase } from "./score.js";

const KEY: CaseKey = {
  id: "c",
  kind: "defect",
  bugs: [
    { id: "b1", reach: "diff", sites: [{ path: "src/a.ts", start: 10, end: 10 }] },
    { id: "b2", reach: "repo", sites: [{ path: "src/a.ts", start: 14, end: 14 }] },
  ],
};

test("a second finding on a caught bug is a false alarm unless another bug it hits is still uncaught", () => {
  const split = [
    { path: "src/a.ts", start: 9, end: 9 },
    { path: "src/a.ts", start: 8, end: 8 },
  ];
  expect(scoreCase(KEY, split)).toEqual({ caught: ["b1"], falseAlarms: 1, flaggedClean: false });
  const both = [
    { path: "src/a.ts", start: 12, end: 12 },
    { path: "src/a.ts", start: 12, end: 12 },
  ];
  expect(scoreCase(KEY, both)).toEqual({ caught: ["b1", "b2"], falseAlarms: 0, flaggedClean: false });
});
