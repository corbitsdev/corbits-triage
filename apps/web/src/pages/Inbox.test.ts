import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckRow } from "./Inbox.js";

test("CheckRow renders ordered evidence accessibly below its reason and source", () => {
  const html = renderToStaticMarkup(createElement(CheckRow, {
    check: {
      check: "focused",
      kind: "model",
      result: "fail",
      reason: "mixes unrelated changes",
      evidence: ["Alpha — src/alpha.ts", "Beta — src/beta.ts"],
    },
  }));

  expect(html).toContain('<span class="mk flag" aria-hidden="true">!</span>');
  expect(html).toContain("mixes unrelated changes");
  expect(html).toContain("Decision model");
  expect(html.match(/<span class="sr-only">Evidence:<\/span>/g)).toHaveLength(2);
  expect(html.indexOf("mixes unrelated changes")).toBeLessThan(html.indexOf("Decision model"));
  expect(html.indexOf("Decision model")).toBeLessThan(html.indexOf("Alpha — src/alpha.ts"));
  expect(html.indexOf("Alpha — src/alpha.ts")).toBeLessThan(html.indexOf("Beta — src/beta.ts"));
});

test("CheckRow with no evidence adds no empty evidence rows", () => {
  const html = renderToStaticMarkup(createElement(CheckRow, {
    check: { check: "ci", kind: "machine", result: "pass", reason: "checks pass", evidence: [] },
  }));
  expect(html).toContain("checks pass");
  expect(html).not.toContain("Evidence:");
  expect(html.match(/<small/g)).toHaveLength(1);
});
