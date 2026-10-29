import { expect, test } from "bun:test";
import { linesOf } from "@corbits/repo-read-tool";
import { addWindow, type LinesRead } from "./lines-read.js";
import { assembled } from "./stock-assembly.test-helpers.js";

const PATCH = Array.from({ length: 600 }, (_, i) => `+  log("changed line ${i + 1}", { value: ${i + 1}, label: "a\\tb" });`).join("\n");

/** read_file's page of the patch from `start`, as the director gets it after the stock result assembly. */
async function readPage(start: number) {
  const page = linesOf("/diff/0001.patch", PATCH, start);
  const call = { id: `read-${start}`, name: "read_file", arguments: { path: page.path, start } };
  return { page, output: await assembled(call, { content: page }) };
}

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
