import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function check(file: string | null): { exitCode: number; stdout: string } {
  const root = mkdtempSync(join(tmpdir(), "policy-check-"));
  if (file === null) mkdirSync(join(root, ".corbits-triage.yml"));
  else writeFileSync(join(root, ".corbits-triage.yml"), file);
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "main.ts"), root, "acme/widgets"]);
  return { exitCode: run.exitCode, stdout: run.stdout.toString() };
}

test("a valid policy file passes", () => {
  expect(check("rules:\n  - check: ci-green\n    text: CI passes.\n    reason: Required.\n    evidence: [maintainer-stated]\n")).toEqual({ exitCode: 0, stdout: ".corbits-triage.yml is valid.\n" });
});

test("an invalid policy file fails with an annotation on each offending line, or on the file", () => {
  const refused = check("rules:\n  - check: focused\n    text: One change.\n    reason: Required.\n    evidence: [maintainer-stated]\n  - check: ci-green\n    text: CI passes.\n    evidence: [maintainer-stated]\n");
  expect(refused.exitCode).toBe(1);
  expect(refused.stdout).toMatch(/^::error file=\.corbits-triage\.yml,line=6::.*reason must be/);
  expect(check("rules: [\n").stdout).toMatch(/^::error file=\.corbits-triage\.yml,line=2,col=1::The policy file is not YAML/);
  expect(check(null)).toEqual({ exitCode: 1, stdout: "::error file=.corbits-triage.yml::.corbits-triage.yml is not a file.\n" });
}, 15_000);

test("a v4 file passes, and a mistake in a block is marked on its line", () => {
  const rules = "rules:\n  - check: ci-green\n    text: CI passes.\n    reason: Required.\n    evidence: [maintainer-stated]\n";
  expect(check(`${rules}code-review: { on: true, provider: anthropic }\ndecide:\n  - { if: { all: clean }, do: approve }\n`)).toEqual({ exitCode: 0, stdout: ".corbits-triage.yml is valid.\n" });
  expect(check(`${rules}security:\n  on: true\n  when: { triage: maybe }\n`).stdout).toBe("::error file=.corbits-triage.yml,line=8::`security.when.triage` must be pass, fail or unsure, or a list of them.\n");
}, 15_000);
