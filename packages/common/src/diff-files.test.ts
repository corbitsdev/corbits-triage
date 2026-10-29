import { expect, test } from "bun:test";
import { diffFiles } from "./diff-files";

test("every changed file is named as git writes it with or without prefixes and quotes, and as Bitbucket Data Center writes it, with its status", () => {
  const sections = [
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    "diff --git src://a b.ts dst://a b.ts\n--- src://a b.ts\n+++ dst://a b.ts\n@@ -1 +1 @@\n-a\n+b\n",
    "diff --git x.ts x.ts\n--- x.ts\n+++ x.ts\n@@ -1 +1 @@\n-a\n+b\n",
    'diff --git "a/caf\\303\\251 \\"q\\".ts" "b/caf\\303\\251 \\"q\\".ts"\n--- "a/caf\\303\\251 \\"q\\".ts"\n+++ "b/caf\\303\\251 \\"q\\".ts"\n@@ -1 +1 @@\n-a\n+b\n',
    "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n",
    "diff --git src://old.ts dst://old.ts\n--- src://old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n",
    "diff --git a/x b/y.png b/x b/y.png\nBinary files a/x b/y.png and b/x b/y.png differ\n",
    "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
    "diff --git a/born.ts b/born.ts\nnew file mode 100644\n--- /dev/null\n+++ b/born.ts\n@@ -0,0 +1 @@\n+a\n",
  ];
  const files = diffFiles(sections.join(""));
  expect(files.map(({ path, status }) => [path, status])).toEqual([
    ["src/a.ts", "modified"],
    ["a b.ts", "modified"],
    ["x.ts", "modified"],
    ['café "q".ts', "modified"],
    ["gone.ts", "deleted"],
    ["old.ts", "deleted"],
    ["x b/y.png", "modified"],
    ["new.ts", "renamed"],
    ["born.ts", "added"],
  ]);
  expect(files.map((file) => file.patch)).toEqual(sections);
  expect(() => diffFiles("diff --git a/p q b/r s\n")).toThrow("unreadable diff header");
});
