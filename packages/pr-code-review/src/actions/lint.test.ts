import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolFindings } from "../findings.js";
import { lintWith } from "./lint.js";

const FILE = "var a = 1;\ndebugger;\nif (a == null) {}\n";
const HUNK = "@@ -1,1 +1,3 @@\n var a = 1;\n+debugger;\n+if (a == null) {}\n";
const RULES = { rules: { "no-var": "error", "no-debugger": "error", eqeqeq: "warn" } };

const lint = lintWith([process.execPath, join(dirname(Bun.resolveSync("oxlint/package.json", import.meta.dir)), "bin/oxlint")]);

const dirs: string[] = [];

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lint-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("the repository's config lints the changed files and keeps only hits on added lines, from either host's diff", async () => {
  const path = checkout({ "a.js": FILE, ".oxlintrc.json": `// rules\n${JSON.stringify(RULES)}` });
  const github = `diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n${HUNK}`;
  const bitbucket = `diff --git src://a.js dst://a.js\n--- src://a.js\n+++ dst://a.js\n${HUNK}`;
  const expected: ToolFindings = {
    status: "complete",
    findings: [
      { source: "oxlint", rule: "eslint(no-debugger)", path: "a.js", line: 2, message: "`debugger` statement is not allowed", severity: "error", fix: "Remove the debugger statement" },
      { source: "oxlint", rule: "eslint(eqeqeq)", path: "a.js", line: 3, message: "Expected === and instead saw ==", severity: "warning", fix: "Prefer === operator" },
    ],
  };
  expect(await lint({ path, diff: github })).toEqual(expected);
  expect(await lint({ path, diff: bitbucket })).toEqual(expected);
});

test("a config that loads code is refused unrun, and a repository without one is not linted", async () => {
  const diff = `diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n${HUNK}`;
  const plugin = "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./ran', import.meta.url), ''); export default { meta: { name: 'p' }, rules: {} };";
  const direct = checkout({ "a.js": FILE, "plugin.mjs": plugin, ".oxlintrc.json": JSON.stringify({ ...RULES, jsPlugins: ["./plugin.mjs"] }) });
  const extended = checkout({ "a.js": FILE, "plugin.mjs": plugin, "base.json": JSON.stringify({ overrides: [{ files: ["*.js"], jsPlugins: ["./plugin.mjs"] }] }), ".oxlintrc.json": JSON.stringify({ extends: ["./base.json"] }) });
  for (const path of [direct, extended]) {
    expect(await lint({ path, diff })).toEqual({ status: "skipped", reason: "config loads code" });
    expect(existsSync(join(path, "ran"))).toBe(false);
  }
  expect(await lint({ path: checkout({ "a.js": FILE, "oxlint.config.ts": "export default {};" }), diff })).toEqual({ status: "skipped", reason: "config loads code" });
  expect(await lint({ path: checkout({ "a.js": FILE }), diff })).toEqual({ status: "skipped", reason: "no lint config" });
});

test("nested configs never load, neither a nested .oxlintrc.json with JS plugins nor an oxlint.config.ts at any level", async () => {
  const plugin = "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./ran', import.meta.url), ''); export default { meta: { name: 'p' }, rules: {} };";
  const code = "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./ran', import.meta.url), ''); export default { rules: {} };";
  function diffFor(name: string) {
    return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${HUNK}`;
  }
  const nested = checkout({ ".oxlintrc.json": JSON.stringify(RULES), "pkg/a.js": FILE, "pkg/plugin.mjs": plugin, "pkg/.oxlintrc.json": JSON.stringify({ jsPlugins: ["./plugin.mjs"] }) });
  await lint({ path: nested, diff: diffFor("pkg/a.js") });
  expect(existsSync(join(nested, "pkg/ran"))).toBe(false);
  const beside = checkout({ ".oxlintrc.json": JSON.stringify(RULES), "oxlint.config.ts": code, "a.js": FILE, "pkg/a.js": FILE, "pkg/oxlint.config.ts": code });
  await lint({ path: beside, diff: diffFor("a.js") + diffFor("pkg/a.js") });
  expect(existsSync(join(beside, "ran"))).toBe(false);
  expect(existsSync(join(beside, "pkg/ran"))).toBe(false);
});

test("a type-aware config is refused before the checkout's tsgolint can run", async () => {
  const diff = `diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n${HUNK}`;
  const path = checkout({ "a.js": FILE, "node_modules/.bin/tsgolint": "#!/bin/sh\ntouch \"$(dirname \"$0\")/ran\"\n", ".oxlintrc.json": JSON.stringify({ ...RULES, options: { typeAware: true } }) });
  chmodSync(join(path, "node_modules/.bin/tsgolint"), 0o755);
  expect(await lint({ path, diff })).toEqual({ status: "skipped", reason: "config loads code" });
  expect(existsSync(join(path, "node_modules/.bin/ran"))).toBe(false);
});

test("a changed file named like an oxlint flag is linted as a file", async () => {
  const name = "--type-aware.js";
  const path = checkout({ [name]: FILE, ".oxlintrc.json": JSON.stringify(RULES) });
  const result = await lint({ path, diff: `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${HUNK}` });
  expect(result).toMatchObject({ status: "complete", findings: [{ path: name, line: 2 }, { path: name, line: 3 }] });
});

test("a lint that cannot run is incomplete, never a clean result", async () => {
  const diff = `diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n${HUNK}`;
  const result = await lint({ path: checkout({ "a.js": FILE, ".oxlintrc.json": JSON.stringify({ rules: { "no-debugger": "loud" } }) }), diff });
  expect(result).toEqual({ status: "incomplete", reason: "oxlint: Failed to parse oxlint configuration file." });
});
