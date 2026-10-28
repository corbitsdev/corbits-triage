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
  ignored: [{ path: "src/b.ts", start: 5, end: 5 }],
};

test("a second finding on a caught bug is a false alarm unless another bug it hits is still uncaught", () => {
  const split = [
    { path: "src/a.ts", start: 9, end: 9 },
    { path: "src/a.ts", start: 8, end: 8 },
  ];
  expect(scoreCase(KEY, split)).toEqual({ caught: ["b1"], falseAlarms: 1, ignored: 0, flaggedClean: false });
  const both = [
    { path: "src/a.ts", start: 12, end: 12 },
    { path: "src/a.ts", start: 12, end: 12 },
  ];
  expect(scoreCase(KEY, both)).toEqual({ caught: ["b1", "b2"], falseAlarms: 0, ignored: 0, flaggedClean: false });
});

test("a finding on a true finding that is not a bug is neither a catch nor a false alarm, even on a clean case", () => {
  const nit = [{ path: "src/b.ts", start: 6, end: 6 }];
  expect(scoreCase(KEY, nit)).toEqual({ caught: [], falseAlarms: 0, ignored: 1, flaggedClean: false });
  expect(scoreCase({ ...KEY, kind: "clean", bugs: [] }, nit)).toEqual({ caught: [], falseAlarms: 0, ignored: 1, flaggedClean: false });
});
