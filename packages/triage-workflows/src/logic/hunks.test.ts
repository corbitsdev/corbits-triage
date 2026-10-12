import { describe, expect, test } from "bun:test";
import { boundedPath, hunkCitations, patchHunks } from "./hunks.js";

describe("patchHunks", () => {
  test("removes terminal, control, and bidi hazards from paths and patches", () => {
    expect(boundedPath(`src/\u001b[31munsafe\u001b[0m\u202efile.ts`)).toBe("src/unsafefile.ts");
    expect(patchHunks("@@ -1 +1 @@\n-const \u001b[32msafe\u001b[0m\u2066Value = 1;\n+const safe\u0000Value = 2;"))
      .toEqual(["@@ -1 +1 @@\n-const safeValue = 1;\n+const safeValue = 2;"]);
  });
});

describe("hunkCitations", () => {
  test("cites each hunk's added lines in the head file and removed lines in the base file, under the old path after a rename", () => {
    const patch = [
      "@@ -38,6 +38,8 @@ export function route() {",
      "   const a = 1;",
      "-  const b = 2;",
      "+  const b = 3;",
      "+  const c = 4;",
      "   const d = 5;",
      "+  const e = 6;",
      "   return a;",
      "@@ -90,4 +92,1 @@",
      " }",
      "-function old() {",
      "-  return 0;",
      "-}",
      "@@ -120 +119 @@",
      "-const last = 1",
      "\\ No newline at end of file",
      "+const last = 2;",
    ].join("\n");
    expect(hunkCitations("src/router.ts", patch)).toEqual([
      { path: "src/router.ts", added: { start: 39, end: 42 }, removed: { path: "src/router.ts", start: 39, end: 39 } },
      { path: "src/router.ts", removed: { path: "src/router.ts", start: 91, end: 93 } },
      { path: "src/router.ts", added: { start: 119, end: 119 }, removed: { path: "src/router.ts", start: 120, end: 120 } },
    ]);
    expect(hunkCitations("src/routes.ts", "@@ -4,2 +4 @@\n-const a = 1;\n-const b = 2;\n+const ab = 3;", "src/router.ts")).toEqual([
      { path: "src/routes.ts", added: { start: 4, end: 4 }, removed: { path: "src/router.ts", start: 4, end: 5 } },
    ]);
    expect(hunkCitations("src/router.ts", "Binary files differ")).toEqual([]);
  });
});
