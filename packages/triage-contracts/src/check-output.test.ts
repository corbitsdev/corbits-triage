import { expect, test } from "bun:test";
import { citationUrl, itemText } from "./check-output.js";

test("a crafted path cannot leave the blob URL or end a markdown link early", () => {
  expect(citationUrl("o/r", "sha", { path: "a)(b`].ts", added: { start: 1, end: 2 } })).toBe("https://github.com/o/r/blob/sha/a%29%28b%60%5D.ts?plain=1#L1-L2");
  expect(citationUrl("o/r", "sha", { path: "d i/r#x?y\n.ts", added: { start: 3, end: 3 } })).toBe("https://github.com/o/r/blob/sha/d%20i/r%23x%3Fy%0A.ts?plain=1#L3");
  expect(citationUrl("o/r", "sha", { path: "a.ts", removed: { path: "a.ts", start: 1, end: 1 } })).toBeUndefined();
});

test("a hunk that adds and removes cites both, naming the old path after a rename", () => {
  expect(itemText({ path: "f.ts", added: { start: 2, end: 2 }, removed: { path: "f.ts", start: 1, end: 8 } })).toBe("f.ts:2 (removed lines 1–8)");
  expect(itemText({ path: "new.ts", removed: { path: "old.ts", start: 4, end: 4 } })).toBe("new.ts (removed line 4 of old.ts)");
});
