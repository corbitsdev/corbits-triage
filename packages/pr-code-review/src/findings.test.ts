import { expect, test } from "bun:test";
import { parseFindings } from "./findings.js";

const REAL = '{"findings": [{"path": "src/a.ts", "start": 2, "end": 2, "priority": 1, "title": "real bug"}]}';

test("the findings list is read past prose with a stray brace and an example object", () => {
  const reply = `The handler opens a block with { and never closes it.\nA finding looks like {"path": "x.ts", "start": 1}.\n${REAL}`;
  expect(parseFindings(reply)).toEqual({ findings: [{ path: "src/a.ts", start: 2, end: 2, priority: 1, title: "real bug" }] });
  for (const unreadable of ["No defects found.", '{"findings": [{"path": "src/a.ts", "start": 1', ""]) expect(parseFindings(unreadable)).toEqual({ unparsable: "no findings list" });
});

test("a quoted example object holding an array of located objects is not a finding", () => {
  const reply = `Config looks like {"rules": [{"path": "x.ts", "start": 1, "end": 1, "title": "lint"}]}. No defects: {"findings": []}`;
  expect(parseFindings(reply)).toEqual({ findings: [] });
});

test("a finding without a priority is not a finding", () => {
  expect(parseFindings('{"findings": [{"path": "src/a.ts", "start": 2, "title": "no priority"}]}')).toEqual({ findings: [] });
});
