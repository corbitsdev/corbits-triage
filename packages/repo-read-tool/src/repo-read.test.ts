import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grep, list, readLines } from "./repo-read";
import { linesOf } from "./lines";

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

test("large text files remain searchable and pageable through their final line", async () => {
  const text = `${"é context\r\n".repeat(200_000)}late_target\n`;
  expect(Buffer.byteLength(text)).toBeGreaterThan(2_000_000);
  writeFileSync(join(root, "large.txt"), text);
  expect(await readLines(root, "large.txt")).toEqual(linesOf("large.txt", text));
  expect(await readLines(root, "large.txt", 200_000, 200_002)).toEqual(linesOf("large.txt", text, 200_000, 200_002));
  expect(await grep(root, "late_target", "large.txt")).toEqual({ matches: [{ path: "large.txt", line: 200_001, text: "late_target" }], truncated: false });
  const many = await grep(root, "^é", "large.txt");
  expect(many.matches).toHaveLength(100);
  expect(many.truncated).toBe(true);
  expect(await readLines(root, "large.txt", 300_000)).toEqual(linesOf("large.txt", text, 300_000));
});

test("streamed reads preserve clipped long lines and reject binary content found after a page", async () => {
  const text = `${"é".repeat(1_100_000)}\nlast\n`;
  writeFileSync(join(root, "long.txt"), text);
  expect(await readLines(root, "long.txt")).toEqual(linesOf("long.txt", text));
  writeFileSync(join(root, "binary.dat"), `${"binary_target\n".repeat(180_000)}\0`);
  await expect(readLines(root, "binary.dat", 1, 1)).rejects.toThrow("binary");
  expect(await grep(root, "binary_target", "binary.dat")).toEqual({ matches: [], truncated: false });
});
