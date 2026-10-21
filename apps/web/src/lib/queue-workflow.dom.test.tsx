import { expect, test } from "bun:test";
import { isInteractiveShortcutTarget } from "./queue-workflow.ts";

test("an open menu holding focus keeps single-key shortcuts from firing", () => {
  document.body.innerHTML = `<div role="menu" tabindex="-1"><span>Held actions</span></div>`;
  const menu = document.querySelector("[role=menu]");
  expect(isInteractiveShortcutTarget(menu)).toBe(true);
  expect(isInteractiveShortcutTarget(document.querySelector("[role=menu] span"))).toBe(true);
  expect(isInteractiveShortcutTarget(document.body)).toBe(false);
});
