import { expect, test } from "bun:test";
import { createSizeCapTransform } from "@intx/inference";
import type { StrategyContext } from "@intx/types/runtime";
import { linesOf } from "@corbits/repo-read-tool";
import { addWindow, type LinesRead } from "./lines-read.js";

const PATCH = Array.from({ length: 600 }, (_, i) => `+  log("changed line ${i + 1}", { value: ${i + 1}, label: "a\\tb" });`).join("\n");

const sizeCap = createSizeCapTransform({ maxChars: 10_000, contextStore: { async writeBlob() {} } });

/** read_file's page of the patch from `start`, as the director gets it after the stock result assembly. */
async function readPage(start: number) {
  const page = linesOf("/diff/0001.patch", PATCH, start);
  const call = { id: `read-${start}`, name: "read_file", arguments: { path: page.path, start } };
  const { output } = await sizeCap.apply({ call, result: { callId: call.id, content: page } }, {} as StrategyContext);
  return { page, output };
}

test("a page of a long patch reaches the reader whole and counts as read", async () => {
  const read: LinesRead = new Map();
  const { page, output } = await readPage(1);
  expect(addWindow(read, output)).toBe(true);
  expect(read.get("/diff/0001.patch")?.size).toBe(page.end);
});

test("paging a 600-line patch from each page's end counts every line read", async () => {
  const read: LinesRead = new Map();
  let start = 1;
  let total = Infinity;
  while (start <= total) {
    const { page, output } = await readPage(start);
    expect(addWindow(read, output)).toBe(true);
    total = page.totalLines;
    start = page.end + 1;
  }
  expect(read.get("/diff/0001.patch")?.size).toBe(600);
});
