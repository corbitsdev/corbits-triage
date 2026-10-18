import { describe, expect, test } from "bun:test";
import { parsePatch } from "./patch.ts";

const PATCH = [
  "@@ -1,3 +1,3 @@ export function a() {",
  " keep",
  "-old",
  "+new",
  " tail",
  "@@ -10,2 +10,3 @@",
  " ten",
  "-last",
  "\\ No newline at end of file",
  "+last",
  "+added",
].join("\n");

describe("parsePatch", () => {
  test("numbers lines from each hunk header", () => {
    const hunks = parsePatch(PATCH);
    expect(hunks.map((hunk) => hunk.header)).toEqual(["@@ -1,3 +1,3 @@ export function a() {", "@@ -10,2 +10,3 @@"]);
    expect(hunks[0]?.lines).toEqual([
      { kind: "ctx", oldNo: 1, newNo: 1, text: "keep" },
      { kind: "del", oldNo: 2, newNo: null, text: "old" },
      { kind: "add", oldNo: null, newNo: 2, text: "new" },
      { kind: "ctx", oldNo: 3, newNo: 3, text: "tail" },
    ]);
    expect(hunks[1]?.lines.map((line) => [line.kind, line.oldNo, line.newNo])).toEqual([
      ["ctx", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["add", null, 12],
    ]);
  });

  test("marks the line before a no-newline marker instead of adding a line", () => {
    const lines = parsePatch(PATCH)[1]?.lines ?? [];
    expect(lines).toHaveLength(4);
    expect(lines[1]).toEqual({ kind: "del", oldNo: 11, newNo: null, text: "last", noNewline: true });
    expect(lines.filter((line) => line.noNewline)).toHaveLength(1);
  });

  test("reads single-line hunk headers without counts", () => {
    expect(parsePatch("@@ -0,0 +1 @@\n+only")[0]?.lines).toEqual([{ kind: "add", oldNo: null, newNo: 1, text: "only" }]);
  });

  test("rejects text that is not a hunk", () => {
    expect(() => parsePatch("Binary files differ")).toThrow();
    expect(() => parsePatch("@@ -1 +1 @@\n?odd")).toThrow();
  });

  test("reads an empty body line as blank context", () => {
    expect(parsePatch("@@ -1,2 +1,2 @@\n\n-a\n+b")[0]?.lines[0]).toEqual({ kind: "ctx", oldNo: 1, newNo: 1, text: "" });
  });
});
