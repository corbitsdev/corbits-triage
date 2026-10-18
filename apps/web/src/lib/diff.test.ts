import { describe, expect, test } from "bun:test";
import { parsePatch } from "@corbits/common/patch";
import { missingPatchReason, splitRows } from "./diff.ts";

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

describe("splitRows", () => {
  test("pairs removals with the additions that follow them", () => {
    const rows = splitRows(parsePatch(PATCH)[1]?.lines ?? []);
    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ["ten", "ten"],
      ["last", "last"],
      [null, "added"],
    ]);
  });
});

describe("missingPatchReason", () => {
  test.each([
    [{ status: "renamed", additions: 0, deletions: 0 }, "Renamed without changes."],
    [{ status: "changed", additions: 0, deletions: 0 }, "File mode changed."],
    [{ status: "added", additions: 0, deletions: 0 }, "No text changes to show."],
    [{ status: "modified", additions: 4000, deletions: 12 }, "Diff too large to show."],
  ])("%o", (file, reason) => {
    expect(missingPatchReason(file)).toBe(reason);
  });
});
