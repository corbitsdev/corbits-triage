import { describe, expect, test } from "bun:test";
import { extractChangeCandidates } from "./candidates.js";
import type { PrFileFacts } from "./checks.js";

describe("extractChangeCandidates", () => {
  test("extracts faithful PR #91 CSS and object-member names from deleted lines", () => {
    const files: PrFileFacts[] = [
      {
        path: "apps/web/src/index.css",
        status: "modified",
        patch: [
          "@@ -452,7 +452,0 @@ body[data-rail=\"collapsed\"] .nav-count {",
          "-.topbar-id {",
          "-  display: flex;",
          "-}",
        ].join("\n"),
      },
      {
        path: "apps/web/src/lib/check-catalog.ts",
        previousPath: "apps/web/src/pages/repo-detail.ts",
        status: "renamed",
        patch: [
          "@@ -31,3 +31,2 @@ export const CHECK_CATALOG = [",
          "-  { id: \"issueMatch\", name: \"Linked issue matches the change\", group: \"issue\", kind: \"quality\" },",
          "+  { id: \"issueMatch\", group: \"issue\", kind: \"quality\" },",
        ].join("\n"),
      },
    ];

    const candidates = extractChangeCandidates(files);
    expect(candidates.map(({ path, previousPath, status, label }) => ({ path, previousPath, status, label }))).toEqual([
      { path: "apps/web/src/index.css", previousPath: undefined, status: "modified", label: ".topbar-id" },
      {
        path: "apps/web/src/lib/check-catalog.ts",
        previousPath: "apps/web/src/pages/repo-detail.ts",
        status: "renamed",
        label: "Linked issue matches the change",
      },
    ]);
    expect(candidates[0]?.evidence).toBe(files[0]?.patch);
    expect(candidates[1]?.evidence).toBe(files[1]?.patch);
  });

  test("uses changed lines only and applies naming priority in stable file and hunk order", () => {
    const files: PrFileFacts[] = [
      {
        path: "src/first.ts",
        status: "modified",
        patch: [
          "@@ -1,2 +1,3 @@",
          " name: \"unchanged context\",",
          "+const lowerPriority = true;",
          "+const item = { title: \"Changed title\", label: \"Changed title\" };",
          "@@ -20 +21 @@",
          "-export function repeated() {}",
          "+export function repeated() {}",
          "@@ -30 +31 @@",
          "+export function repeated() {}",
        ].join("\n"),
      },
      {
        path: "styles/second.scss",
        patch: [
          "@@ -4,2 +4,2 @@",
          "-.one {",
          "+.two {",
        ].join("\n"),
      },
    ];

    expect(extractChangeCandidates(files).map((candidate) => `${candidate.path}|${candidate.label}`)).toEqual([
      "src/first.ts|Changed title",
      "src/first.ts|repeated",
      "src/first.ts|repeated",
      "styles/second.scss|.one",
      "styles/second.scss|.two",
    ]);
  });

  test("keeps evidence and metadata associated only with their originating file and hunk", () => {
    const candidates = extractChangeCandidates([
      {
        path: "src/a.ts",
        previousPath: "src/old-a.ts",
        status: "renamed",
        patch: "@@ -1 +1 @@\n-export class Before {}\n+export class After {}",
      },
      {
        path: "src/b.ts",
        status: "added",
        patch: "@@ -0,0 +1 @@\n+export function buildB() {}",
      },
    ]);
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ path: "src/a.ts", previousPath: "src/old-a.ts", status: "renamed", label: "Before" });
    expect(candidates[1]).toMatchObject({ path: "src/a.ts", previousPath: "src/old-a.ts", status: "renamed", label: "After" });
    expect(candidates[2]).toMatchObject({ path: "src/b.ts", status: "added", label: "buildB" });
    expect(candidates[0]?.evidence).not.toContain("buildB");
    expect(candidates[2]?.evidence).not.toContain("Before");
  });

  test("uses path and coordinate fallbacks for absent, empty, malformed, and unnamed patches", () => {
    expect(extractChangeCandidates([
      { path: "missing.ts" },
      { path: "empty.ts", patch: "" },
      { path: "malformed.ts", patch: "+const value = 1;\n\\ No newline at end of file" },
      { path: "unnamed.ts", patch: "@@ -8 +9 @@\n-return oldValue;\n+return newValue;\n\\ No newline at end of file" },
    ])).toEqual([
      { path: "missing.ts", label: "missing.ts", evidence: "" },
      { path: "empty.ts", label: "empty.ts", evidence: "" },
      { path: "malformed.ts", label: "malformed.ts", evidence: "+const value = 1;\n\\ No newline at end of file" },
      {
        path: "unnamed.ts",
        label: "unnamed.ts:9",
        evidence: "@@ -8 +9 @@\n-return oldValue;\n+return newValue;\n\\ No newline at end of file",
      },
    ]);
  });

  test("removes terminal, control, and bidi hazards while preserving evidence lines", () => {
    const path = `src/\u001b[31munsafe\u001b[0m\u202efile.ts`;
    const [candidate] = extractChangeCandidates([{
      path,
      patch: "@@ -1 +1 @@\n-const \u001b[32msafe\u001b[0m\u2066Value = 1;\n+const safe\u0000Value = 2;",
    }]);
    expect(candidate).toEqual({
      path: "src/unsafefile.ts",
      label: "safeValue",
      evidence: "@@ -1 +1 @@\n-const safeValue = 1;\n+const safeValue = 2;",
    });
  });

  test("enforces stable file, input, candidate, evidence, label, and path bounds", () => {
    const labels = Array.from({ length: 205 }, (_, index) => `+const candidate${index} = true;`).join("\n");
    const candidates = extractChangeCandidates([
      {
        path: `${"p".repeat(600)}.ts`,
        patch: `@@ -0,0 +1,205 @@\n${labels}\n+const ${"l".repeat(200)} = true;\n${"+x\n".repeat(20_000)}`,
      },
      ...Array.from({ length: 100 }, (_, index) => ({ path: `fallback-${index}.ts` })),
    ]);
    expect(candidates).toHaveLength(200);
    expect(candidates[0]?.path.length).toBe(512);
    expect(candidates[0]?.evidence.length).toBe(4_096);
    expect(candidates.every((candidate) => candidate.label.length <= 160)).toBe(true);

    const fileBound = extractChangeCandidates(Array.from({ length: 101 }, (_, index) => ({ path: `fallback-${index}.ts` })));
    expect(fileBound).toHaveLength(100);
    expect(fileBound.at(-1)?.path).toBe("fallback-99.ts");

    const beyondInput = `@@ -0,0 +1 @@\n+return value;\n${"x".repeat(65_536)}\n+const tooLate = true;`;
    expect(extractChangeCandidates([{ path: "input.ts", patch: beyondInput }]).map((candidate) => candidate.label))
      .toEqual(["input.ts:1"]);

    const longLabel = "l".repeat(200);
    expect(extractChangeCandidates([{ path: "label.ts", patch: `@@ -0,0 +1 @@\n+const value = { name: "${longLabel}" };` }])[0]?.label)
      .toBe("l".repeat(160));
  });

  test("treats absent optional facts files as no candidates", () => {
    expect(extractChangeCandidates(undefined)).toEqual([]);
  });

  test("does not mutate the input array or file records", () => {
    const file = Object.freeze({ path: "src/frozen.ts", status: "modified", patch: "@@ -0,0 +1 @@\n+const frozen = true;" });
    const files = Object.freeze([file]);
    expect(extractChangeCandidates(files)).toMatchObject([{ path: "src/frozen.ts", status: "modified", label: "frozen" }]);
    expect(files[0]).toBe(file);
  });

  test("treats triple-sign lines inside a hunk as changed source, not file headers", () => {
    expect(extractChangeCandidates([{
      path: "src/counters.ts",
      patch: [
        "@@ -1 +1 @@",
        "---count, consume({ name: \"Before\" });",
        "+++count, consume({ name: \"After\" });",
      ].join("\n"),
    }]).map((candidate) => candidate.label)).toEqual(["Before", "After"]);
  });

  test("extracts the declared name from a const enum", () => {
    expect(extractChangeCandidates([{
      path: "src/mode.ts",
      patch: "@@ -0,0 +1 @@\n+export const enum Mode { On, Off }",
    }])).toMatchObject([{ label: "Mode" }]);
  });

  test("detects file type from the same sanitized path returned by the candidate", () => {
    expect(extractChangeCandidates([{
      path: "src/config.ts\u001b[31m",
      patch: "@@ -1 +1 @@\n-const config = {};\n+const config = { name: \"Visible label\" };",
    }])).toMatchObject([{ path: "src/config.ts", label: "Visible label" }]);
  });

  test("windows bounded evidence around the changed line that produced a late label", () => {
    const earlier = `+// ${"earlier ".repeat(600)}`;
    const [candidate] = extractChangeCandidates([{
      path: "src/late.ts",
      patch: `@@ -0,0 +1,2 @@\n${earlier}\n+const config = { name: "Late label" };`,
    }]);
    expect(candidate?.label).toBe("Late label");
    expect(candidate?.evidence.length).toBeLessThanOrEqual(4_096);
    expect(candidate?.evidence).toContain('+const config = { name: "Late label" };');
  });

  test("windows long-line evidence around the raw match when label whitespace is normalized", () => {
    const [candidate] = extractChangeCandidates([{
      path: "src/long-line.ts",
      patch: `@@ -0,0 +1 @@\n+void 0, /* ${"x".repeat(5_000)} */ ({ name: "Late  label" });`,
    }]);
    expect(candidate?.label).toBe("Late label");
    expect(candidate?.evidence.length).toBeLessThanOrEqual(4_096);
    expect(candidate?.evidence).toContain('name: "Late  label"');
  });
});
