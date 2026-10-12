import { expect, test } from "bun:test";
import { markdownHtml } from "./markdown.ts";

test("a body nested thousands of levels deep is not parsed", () => {
  expect(markdownHtml(`${">".repeat(5000)} deep`)).toBeNull();
  expect(markdownHtml(Array.from({ length: 5000 }, (_, level) => `${"  ".repeat(level)}- item`).join("\n"))).toBeNull();
});

test("headings render below the pane's own", () => {
  expect(markdownHtml("# Summary")).toBe("<p><strong>Summary</strong></p>");
});
