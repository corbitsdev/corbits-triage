import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";

import { buildEntry, packTool } from "./build";

const scratch = await mkdtemp(path.join(tmpdir(), "github-tool-pack-"));
afterAll(async function cleanup() {
  await rm(scratch, { recursive: true, force: true });
});

test("packs a byte-identical, self-contained tool tarball that loads under Node", async () => {
  const first = await packTool(await buildEntry(path.join(scratch, "a/index.js")), path.join(scratch, "a"));
  const second = await packTool(await buildEntry(path.join(scratch, "b/index.js")), path.join(scratch, "b"));
  expect(second.integrity).toBe(first.integrity);

  const extracted = path.join(scratch, "extracted");
  await mkdir(extracted);
  await tar.x({ file: first.path, cwd: extracted });
  const manifest = JSON.parse(await readFile(path.join(extracted, "package/package.json"), "utf8"));
  expect(manifest.dependencies).toBeUndefined();
  expect(manifest.private).toBeUndefined();
  expect(manifest.interchange.tools).toBe("./dist/index.js");

  const entry = path.join(extracted, "package", manifest.interchange.tools);
  const bundle = await readFile(entry, "utf8");
  expect(bundle).not.toContain("node_modules");
  expect(bundle).not.toContain("vendor/interchange");
  const program = `const m = await import(${JSON.stringify(pathToFileURL(entry).href)});
console.log(JSON.stringify([m.githubRead.id, m.githubWrite.id]));`;
  const proc = Bun.spawn(["node", "--input-type=module", "-e", program], { cwd: extracted, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual([
    "@corbits/github-tool/sidecar-bundle",
    "@corbits/github-write-tool/sidecar-bundle",
  ]);
}, 60_000);
