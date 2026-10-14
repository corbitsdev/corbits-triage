import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffView, type DiffFile } from "./DiffView.tsx";

const FILE: DiffFile = { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n keep\n-old\n+new" };

function render(file: DiffFile, layout: "stacked" | "split", canSplit = true): string {
  return renderToStaticMarkup(createElement(DiffView, { file, layout, canSplit, onLayout: () => {} }));
}

describe("DiffView", () => {
  test("split puts the removal and its addition on one row", () => {
    const html = render(FILE, "split");
    expect(html.match(/class="diff-split-row"/g)).toHaveLength(2);
    expect(html).toMatch(/<span class="code del"><span class="sr-only">removed: <\/span>old<\/span>.*<span class="code add"><span class="sr-only">added: <\/span>new<\/span>/);
    expect(html).toContain("src/old.ts</span> → src/new.ts");
  });

  test("collapses long diffs behind an expand control", () => {
    const patch = ["@@ -0,0 +1,600 @@", ...Array.from({ length: 600 }, (_, i) => `+line ${i}`)].join("\n");
    const html = render({ path: "big.ts", status: "added", additions: 600, deletions: 0, patch }, "stacked");
    expect(html).toContain("Expand 600 lines");
    expect(html).not.toContain("diff-line");
  });
});
