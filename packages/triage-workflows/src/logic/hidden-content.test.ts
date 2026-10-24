import { expect, test } from "bun:test";
import { hiddenMarkup } from "./hidden-content.js";

test("a hidden comment as long as GitHub allows, repeating a pattern's first word, is read quickly", () => {
  const body = `<!--${"close ".repeat(10_922).slice(0, 65_536 - "<!---->".length)}-->`;
  const started = performance.now();
  expect(hiddenMarkup(body, "", [])).toEqual([]);
  expect(performance.now() - started).toBeLessThan(200);
});
