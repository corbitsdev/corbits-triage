import { expect, test } from "bun:test";
import { findingSection, inlineFindingText, parseFindingHeadline, type CodeReviewComment } from "./code-review.js";

const RESOLVE = "Resolve this comment. Triage will not finish while it is open.";

const finding: CodeReviewComment = {
  path: "src/a.ts",
  start: 8,
  end: 14,
  title: "Off by one",
  body: "The loop stops early.",
  priority: 1,
  unverified: true,
};

test("inline and summary findings end by asking to resolve the comment, and the headline is still only the first line", () => {
  const inline = inlineFindingText(finding, { start: 10, end: 12 });
  const section = findingSection(finding);
  expect(inline).toBe(`**P1 · Off by one**\n\nThe loop stops early.\n\nAlso lines 8–9 and 13–14.\n\n_Not checked against the file._\n\n${RESOLVE}`);
  expect(section).toBe(`**P1 · Off by one** · \`src/a.ts:8–14\`\n\nThe loop stops early.\n\n_Not checked against the file._\n\n${RESOLVE}`);
  expect(parseFindingHeadline(inline)).toEqual({ title: "Off by one", priority: 1 });
  expect(parseFindingHeadline(section).title).toBe(section.split("\n", 1)[0]);
  expect(parseFindingHeadline(`${inline}\n\n${RESOLVE} again`).title).not.toContain("Resolve");
});
