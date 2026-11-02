import { checkPolicyFile, policyFileReason } from "@corbits/triage-contracts";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "./build.js";

const RULES = `rules:
  - check: ci-green
    text: CI passes.
    reason: Required.
    evidence: [maintainer-stated]
`;

const FORBIDDEN = [
  'from "@corbits/',
  "from '@corbits/",
  'require("@corbits/',
  "require('@corbits/",
  'from "@intx/',
  "from '@intx/",
  'require("@intx/',
  "require('@intx/",
];

async function runNode(node: string, cli: string, ...args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn([node, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
}

test("the node bundle has no workspace specifiers and checks a policy file", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "triage-verify-bundle-"));
  let validDir: string | undefined;
  try {
    await build(outDir);

    const cliPath = join(outDir, "cli.js");
    const bundled = readFileSync(cliPath, "utf8");
    expect(bundled.split("\n")[0]).toBe("#!/usr/bin/env node");
    for (const item of FORBIDDEN) expect(bundled).not.toContain(item);
    expect(bundled).not.toContain("workspace:");

    const manifestText = readFileSync(join(outDir, "package.json"), "utf8");
    const manifest = JSON.parse(manifestText) as {
      name?: string;
      bin?: { "triage-verify"?: string };
      files?: string[];
      dependencies?: unknown;
      devDependencies?: unknown;
      optionalDependencies?: unknown;
      peerDependencies?: unknown;
    };
    expect(manifest.name).toBe("@corbits/triage-verify");
    expect(manifest.bin).toEqual({ "triage-verify": "./cli.js" });
    expect(manifest.files).toEqual([
      "cli.js",
      "README.md",
      "LICENSE.md",
      "GPL-2.0.txt",
      "GPLv2-AI-Exception.md",
    ]);
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("workspace:");
    expect(manifestText).not.toContain("workspace:");

    const repoRoot = join(import.meta.dir, "../../..");
    for (const name of ["GPL-2.0.txt", "GPLv2-AI-Exception.md"]) {
      expect(readFileSync(join(outDir, name))).toEqual(readFileSync(join(repoRoot, name)));
    }

    const node = Bun.which("node");
    if (node === null) throw new Error("node is not on PATH");

    validDir = mkdtempSync(join(tmpdir(), "triage-verify-"));
    const validPath = join(validDir, "policy.yml");
    writeFileSync(validPath, RULES);
    const valid = await runNode(node, cliPath, validPath);
    expect(valid.exitCode).toBe(0);
    expect(valid.stderr).toBe("");

    const invalidText = RULES.replace("    reason: Required.\n", "");
    const checked = checkPolicyFile(invalidText, "owner/name");
    if (checked.ok) throw new Error("the policy is valid");
    const invalidPath = join(validDir, "invalid.yml");
    writeFileSync(invalidPath, invalidText);
    const invalid = await runNode(node, cliPath, invalidPath);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toBe(`${policyFileReason(checked.problems)}\n`);

    const missingPath = join(validDir, "missing.yml");
    const missing = await runNode(node, cliPath, missingPath);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toBe(`No such file: ${missingPath}\n`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    if (validDir !== undefined) rmSync(validDir, { recursive: true, force: true });
  }
});
