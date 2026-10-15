import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { errorText } from "@corbits/common";
import { bitbucketPrFromUrl, runBitbucket, sessionFetch } from "../bitbucket/run.ts";
import { send } from "../messages.ts";
import type { PrRef } from "../pr.ts";
import type { RunState } from "../storage.ts";
import type { TriageView } from "../view.ts";
import { verdictChip } from "./chip.ts";
import { triageBlock } from "./triage-block.ts";

// Data Center's own semantic class names, stable across its React rewrite; its data-testids cover only the controls.
const CHIP_ANCHOR = "header.pull-request-header .pull-request-title-review-section";
const REVIEW_BUTTON = ":scope > .review-mode-button";
const BLOCK_ANCHOR = ".pull-request-overview .pull-request-activities";

/** Spike: chip in the header on every tab, block atop Activity on Overview; read-only, with the viewer's session. */
export async function startBitbucketContentScript(ctx: ContentScriptContext): Promise<void> {
  let current: PrRef | undefined;
  let view: TriageView | undefined;
  let run: RunState | undefined;

  const block = triageBlock({
    rerun() {
      if (current) check(current);
    },
    openPanel() {
      send({ type: "open-panel" });
    },
  });
  const chip = verdictChip(function showBlock() {
    block.element.scrollIntoView({ block: "nearest" });
    block.element.focus({ preventScroll: true });
  });

  const chipUi = await createShadowRootUi(ctx, {
    name: "corbits-triage-chip",
    position: "inline",
    anchor: () => document.querySelector(CHIP_ANCHOR),
    // Before Start review on an open pull request; a merged or declined one has no such button, so the chip ends the row.
    append(anchor, ui) {
      anchor.insertBefore(ui, anchor.querySelector(REVIEW_BUTTON));
    },
    onMount(container) {
      container.className = "inline-root";
      container.append(chip.element);
    },
  });
  const blockUi = await createShadowRootUi(ctx, {
    name: "corbits-triage-block",
    position: "inline",
    anchor: () => document.querySelector(BLOCK_ANCHOR),
    append: "first",
    onMount(container) {
      container.append(block.element);
    },
  });
  const slots = [
    { ui: chipUi, anchor: CHIP_ANCHOR, placed: () => chipUi.shadowHost.parentElement?.matches(CHIP_ANCHOR) === true },
    { ui: blockUi, anchor: BLOCK_ANCHOR, placed: () => blockUi.shadowHost.parentElement?.matches(BLOCK_ANCHOR) === true },
  ];

  // Tabs are in-page route changes that swap the tab pane and keep the header, so the block is put back whenever Overview returns.
  function keepMounted() {
    for (const slot of slots) {
      if (!current) {
        if (slot.ui.shadowHost.isConnected) slot.ui.remove();
      } else if (!(slot.ui.shadowHost.isConnected && slot.placed()) && document.querySelector(slot.anchor)) slot.ui.mount();
    }
  }

  function render() {
    chip.render(view, run);
    block.render(view, run);
    keepMounted();
  }

  async function check(pr: PrRef) {
    run = { running: true, at: new Date().toISOString() };
    render();
    try {
      view = await runBitbucket(sessionFetch(location.origin), pr);
      run = { running: false, at: new Date().toISOString() };
    } catch (cause) {
      run = { running: false, error: errorText(cause), at: new Date().toISOString() };
    }
    render();
  }

  let shownKey = "";
  function onLocation() {
    current = bitbucketPrFromUrl(location.href);
    const key = current ? `${current.repo}#${current.number}` : "";
    if (key === shownKey) return keepMounted();
    shownKey = key;
    view = undefined;
    run = undefined;
    if (current) check(current);
    else keepMounted();
  }

  let queued = false;
  const observer = new MutationObserver(function onMutation() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function checkMounted() {
      queued = false;
      onLocation();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  ctx.onInvalidated(function stopObserving() {
    observer.disconnect();
  });
  onLocation();
}
