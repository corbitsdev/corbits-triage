import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedLines } from "@corbits/common/diff-files";
import { changesBetween } from "./changes.js";

test("exact snapshot comparison handles additions, deletions and quoted paths without rewriting code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-changes-"));
  const before = "a".repeat(40);
  const after = "b".repeat(40);
  try {
    await mkdir(join(dir, before));
    await mkdir(join(dir, after));
    const nested = `a/${before}/file.ts`;
    await mkdir(join(dir, before, "a", before), { recursive: true });
    await mkdir(join(dir, after, "a", before), { recursive: true });
    await writeFile(join(dir, before, nested), `-- a/${before}/code\n`);
    await writeFile(join(dir, after, nested), `++ b/${after}/code\n`);
    await writeFile(join(dir, before, "gone.ts"), "gone\n");
    await writeFile(join(dir, after, "new.ts"), "new\n");
    await writeFile(join(dir, before, "space ü.ts"), "old\n");
    await writeFile(join(dir, after, "space ü.ts"), `a/${before}/literal\n`);
    const diff = await changesBetween(dir, before, after);
    const added = addedLines(diff);
    expect([...added.keys()].sort()).toEqual([nested, "new.ts", "space ü.ts"]);
    expect(diff).toContain(`+a/${before}/literal`);
    expect(diff).toContain("--- a/gone.ts");
    expect(diff).toContain(`--- a/${before}/code`);
    expect(diff).toContain(`+++ b/${after}/code`);
    expect(await changesBetween(dir, before, before)).toBe("");
    await expect(changesBetween(dir, "../escape", after)).rejects.toThrow("pinned commits");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
