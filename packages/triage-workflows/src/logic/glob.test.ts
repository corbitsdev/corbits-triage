import { expect, test } from "bun:test";
import { globMatch } from "./glob.js";

test("* stays within a segment and ** crosses segments", () => {
  expect(globMatch("vendor/a/b.ts", "vendor/**")).toBe(true);
  expect(globMatch("vendor/a/b.ts", "vendor/*")).toBe(false);
  expect(globMatch("src/a.test.ts", "src/*.test.ts")).toBe(true);
});

test("regex metacharacters match literally", () => {
  expect(globMatch("a?b", "a?b")).toBe(true);
  expect(globMatch("b", "a?b")).toBe(false);
  expect(globMatch("x(1)[2]{3}+|$^.ts", "x(1)[2]{3}+|$^.ts")).toBe(true);
  expect(globMatch("xyts", "x.ts")).toBe(false);
});

test("a glob that backtracks exponentially still matches in linear time", () => {
  const started = performance.now();
  expect(globMatch("a".repeat(40), `${"**a".repeat(12)}**b`)).toBe(false);
  expect(performance.now() - started).toBeLessThan(100);
});
