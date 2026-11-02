import { checkPolicyFile, policyFileReason } from "@corbits/triage-contracts";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");

const RULES = `rules:
  - check: ci-green
    text: CI passes.
    reason: Required.
    evidence: [maintainer-stated]
`;

async function run(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  return { exitCode: await proc.exited, stdout, stderr };
}

function policy(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "triage-verify-"));
  const path = join(dir, "policy.yml");
  writeFileSync(path, text);
  return path;
}

test("a valid file exits 0 with no output", async () => {
  const { exitCode, stdout, stderr } = await run(policy(RULES));
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});

test("an invalid file exits 1 with the hub reasons", async () => {
  const text = RULES.replace("    reason: Required.\n", "");
  const checked = checkPolicyFile(text, "owner/name");
  if (checked.ok) throw new Error("the policy is valid");
  const { exitCode, stderr } = await run(policy(text));
  expect(exitCode).toBe(1);
  expect(stderr).toBe(`${policyFileReason(checked.problems)}\n`);
});

test("a missing file exits 1", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "triage-verify-")), "missing.yml");
  const { exitCode, stderr } = await run(path);
  expect(exitCode).toBe(1);
  expect(stderr).toBe(`No such file: ${path}\n`);
});

test("a pending block warns and exits 0", async () => {
  const { exitCode, stderr } = await run(policy(`${RULES}deslop: { on: false }\n`));
  expect(exitCode).toBe(0);
  expect(stderr.startsWith("warning: ")).toBe(true);
  expect(stderr).toContain("security and deslop reviews are not available yet");
});

test("help names that extends is not resolved", async () => {
  const { exitCode, stdout } = await run("--help");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("`extends` is not resolved: a parent policy is not loaded.");
});

test("a rejected owner and name exits 2 without reading the policy", async () => {
  const path = policy(RULES);
  const rejected = await run("--owner", "..", "--name", "name", path);
  expect(rejected.exitCode).toBe(2);
  expect(rejected.stderr).toBe("Repository must be owner/name.\n");
  expect(rejected.stderr).not.toContain("YAML");
  expect(rejected.stderr).not.toContain("reason must be");
  const unpaired = await run("--owner", "acme", path);
  expect(unpaired.exitCode).toBe(2);
});
