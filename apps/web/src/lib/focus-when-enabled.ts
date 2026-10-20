import { useRef } from "react";

/**
 * Focuses the element with `id` as soon as it can take focus. A control disabled while its change saves cannot be
 * focused when the save settles, only after the render that enables it; `afterRender` is a ref callback that a
 * parent of the control passes on every render to catch that render.
 */
export function useFocusWhenEnabled(id: string) {
  const wanted = useRef(false);

  function focusIfEnabled() {
    const target = document.getElementById(id);
    if (!wanted.current || !target || target.matches(":disabled")) return;
    target.focus();
    wanted.current = false;
  }

  function afterRender(node: HTMLElement | null) {
    if (node) focusIfEnabled();
  }

  function focusSoon() {
    wanted.current = true;
    focusIfEnabled();
  }

  return { focusSoon, afterRender };
}
