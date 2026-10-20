import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFocusWhenEnabled } from "./focus-when-enabled.ts";

let root: Root | undefined;

afterEach(function unmount() {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

test("a switch disabled while its change saves gets focus on the render that enables it", () => {
  let focusSoon: () => void = () => {};

  function Card({ saving }: { saving: boolean }) {
    const focus = useFocusWhenEnabled("switch");
    focusSoon = focus.focusSoon;
    return <div ref={focus.afterRender}><button id="switch" type="button" disabled={saving}>Code review</button></div>;
  }

  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<Card saving />));

  act(() => focusSoon());
  expect(document.activeElement?.id).not.toBe("switch");

  act(() => root?.render(<Card saving={false} />));
  expect(document.activeElement?.id).toBe("switch");
});
