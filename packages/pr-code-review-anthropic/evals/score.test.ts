import { expect, test } from "bun:test";
import { loadKeys, type CaseKey } from "./cases.js";
import { scoreCase } from "./score.js";

const KEY: CaseKey = {
  id: "c",
  kind: "defect",
  bugs: [
    { id: "b1", reach: "diff", sites: [{ path: "src/a.ts", start: 10, end: 10 }] },
    { id: "b2", reach: "repo", sites: [{ path: "src/a.ts", start: 14, end: 14 }] },
  ],
  ignored: [
    { id: "i1", sites: [{ path: "src/a.ts", start: 10, end: 10 }] },
    { id: "i2", sites: [{ path: "src/b.ts", start: 5, end: 5 }] },
  ],
};

test("ten identical findings on one defect score one catch and nine false alarms", () => {
  const [key] = loadKeys(["disaster-ninja-fe-1230"]);
  if (!key) throw new Error("no key");
  const spam = Array.from({ length: 10 }, () => ({ path: "src/core/logical_layers/renderers/GenericRenderer.ts", start: 236, end: 236 }));
  const score = scoreCase(key, spam);
  expect(score.caught).toHaveLength(1);
  expect(score.falseAlarms).toBe(9);
  expect(score.ignored).toBe(0);
});

test("a finding catches an uncaught bug it hits, else is a false alarm when it hits a caught one", () => {
  const findings = [
    { path: "src/a.ts", start: 12, end: 12 },
    { path: "src/a.ts", start: 12, end: 12 },
    { path: "src/a.ts", start: 10, end: 10 },
  ];
  expect(scoreCase(KEY, findings)).toMatchObject({
    caught: ["b1", "b2"],
    falseAlarms: 1,
    ignored: 0,
    outcomes: [{ kind: "caught", bug: "b1" }, { kind: "caught", bug: "b2" }, { kind: "falseAlarm" }],
  });
});

test("each ignored item absorbs one finding, also on a clean case", () => {
  const twice = [
    { path: "src/b.ts", start: 6, end: 6 },
    { path: "src/b.ts", start: 6, end: 6 },
  ];
  const clean = { ...KEY, kind: "clean" as const, bugs: [] };
  expect(scoreCase(clean, twice)).toMatchObject({ falseAlarms: 1, ignored: 1, flaggedClean: true, outcomes: [{ kind: "ignored", item: "i2" }, { kind: "falseAlarm" }] });
  expect(scoreCase(clean, twice.slice(1))).toMatchObject({ falseAlarms: 0, ignored: 1, flaggedClean: false });
});
