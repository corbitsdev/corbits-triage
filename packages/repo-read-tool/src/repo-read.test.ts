import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grep, list, readLines } from "./repo-read";

let dir: string;
let root: string;

beforeAll(function makeTree() {
  dir = mkdtempSync(join(tmpdir(), "repo-read-"));
  root = join(dir, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "const secret = 1;\n");
  writeFileSync(join(dir, "outside.txt"), "secret outside\n");
  symlinkSync(join(dir, "outside.txt"), join(root, "link.txt"));
  symlinkSync(dir, join(root, "up"));
});

afterAll(function removeTree() {
  rmSync(dir, { recursive: true, force: true });
});

test("reads inside the checkout", async () => {
  expect((await readLines(root, "src/a.ts")).text).toBe("1\tconst secret = 1;\n2\t");
});

test("refuses paths that leave the checkout", async () => {
  for (const path of ["../outside.txt", join(dir, "outside.txt"), "link.txt", "up/outside.txt"]) {
    await expect(readLines(root, path)).rejects.toThrow("outside the repository");
  }
  await expect(list(root, "up")).rejects.toThrow("outside the repository");
});

test("grep does not follow symlinks out", async () => {
  expect((await grep(root, "secret")).matches.map((m) => m.path)).toEqual(["src/a.ts"]);
});
