import { expect, test } from "bun:test";
import { globMatch } from "./glob.js";

test.each([
  ["vendor/a/b.ts", "vendor/**", true],
  ["vendor/a/b.ts", "vendor/*", false],
  ["src/a.test.ts", "src/*.test.ts", true],
  ["README.md", "**/*.md", true],
  ["docs/a/README.md", "**/*.md", true],
  ["src/a.ts", "src/**/*.ts", true],
  ["src/a/b/c.ts", "src/**/*.ts", true],
  ["lib/a.ts", "src/**/*.ts", false],
  [".env", "**/.env", true],
  ["app/.env", "**/.env", true],
  ["app/.env.local", "**/.env", false],
  ["docs/a.md", "**.md", true],
  ["xsrc/a.ts", "**/src/*.ts", false],
] as const)("%s against %s is %p", (path, glob, matches) => {
  expect(globMatch(path, glob)).toBe(matches);
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

test("a full pack of globs over a large pull request matches quickly", () => {
  const paths = Array.from({ length: 3000 }, (_, i) => `src/module${i}/file${i}.ts`);
  const globs = Array.from({ length: 50 }, (_, i) => `vendor${i}/**/*.ts`);
  const started = performance.now();
  expect(paths.some((path) => globs.some((glob) => globMatch(path, glob)))).toBe(false);
  expect(performance.now() - started).toBeLessThan(200);
});
