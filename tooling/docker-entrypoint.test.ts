import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

async function stderrOf(command: string[], cwd: string): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd,
    env: {},
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

afterEach(function removeTemporaryDirectories() {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Docker Bun entrypoints", () => {
  test("hub container command resolves modules before validating its environment", async () => {
    const result = await stderrOf([process.execPath, "--conditions=intx-src", "apps/hub/src/server.ts"], ROOT);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("environment variable is required");
    expect(result.stderr).not.toContain("Cannot find package");
    expect(result.stderr).not.toContain("ModuleNotFound");
  });

  test("conditioned hub bundle starts from a clean temporary directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "corbits-hub-entrypoint-"));
    temporaryDirectories.push(directory);
    const bundle = join(directory, "server.js");
    const build = Bun.spawnSync([
      process.execPath,
      "build",
      "--conditions=intx-src",
      "apps/hub/src/server.ts",
      "--target",
      "bun",
      "--outfile",
      bundle,
    ], {
      cwd: ROOT,
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(build.exitCode).toBe(0);
    const result = await stderrOf([process.execPath, bundle], directory);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("environment variable is required");
    expect(result.stderr).not.toContain(ROOT);
    expect(result.stderr).not.toContain("Cannot find package");
  });
});
