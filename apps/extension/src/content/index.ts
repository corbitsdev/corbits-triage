import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi, type ShadowRootContentScriptUi } from "wxt/utils/content-script-ui/shadow-root";
import { errorText } from "@corbits/common";
import { send } from "../messages.ts";
import type { FileNote } from "../notes.ts";
import { prFromUrl, prKey, type PrRef } from "../pr.ts";
import { runStates, views, type RunState } from "../storage.ts";
import type { TriageView } from "../view.ts";
import { verdictChip } from "./chip.ts";
import { fileMarker, markLines, noteAnchor, onFilesTab, type FileMarker } from "./file-notes.ts";
import { triageBlock } from "./triage-block.ts";

// After the number in the new pull request page's header (not its sticky copy), then in the classic one's. GitHub's
// CSS-module class names change suffix between deploys, so only their stable stem is matched.
const TITLE_ANCHOR = '[class*="titleWithAction"] > [class*="titleSuffix"], .gh-header-title';
const SIDEBAR_ANCHOR = "#partial-discussion-sidebar";

type Marker = { marker: FileMarker; ui?: ShadowRootContentScriptUi<void>; shown?: FileNote[] };

async function settle(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (cause) {
    console.warn(errorText(cause));
  }
}

function notesByPath(view: TriageView | undefined): Map<string, FileNote[]> {
  const notes = new Map<string, FileNote[]>();
  for (const note of view?.notes ?? []) notes.set(note.path, [...(notes.get(note.path) ?? []), note]);
  return notes;
}

export async function startContentScript(ctx: ContentScriptContext): Promise<void> {
  let current: PrRef | undefined;
  let allViews: Record<string, TriageView> = {};
  let allStates: Record<string, RunState> = {};

  const block = triageBlock({
    rerun() {
      if (current) send({ type: "triage", pr: current, mode: "refetch" });
    },
    openPanel() {
      send({ type: "open-panel" });
    },
  });
  const chip = verdictChip(function showBlock() {
    block.element.scrollIntoView({ block: "nearest" });
    block.element.focus({ preventScroll: true });
  });

  async function shadow(name: string, anchor: () => Element | null, append: "after" | "first", content: HTMLElement, className?: string) {
    return createShadowRootUi(ctx, {
      name,
      position: "inline",
      anchor,
      append,
      onMount(container) {
        if (className) container.className = className;
        container.append(content);
      },
    });
  }

  const chipUi = await shadow("corbits-triage-chip", () => document.querySelector(TITLE_ANCHOR), "after", chip.element, "inline-root");
  const blockUi = await shadow("corbits-triage-sidebar", () => document.querySelector(SIDEBAR_ANCHOR), "first", block.element);
  const slots = [
    { ui: chipUi, anchor: () => document.querySelector(TITLE_ANCHOR), placed: () => chipUi.shadowHost.previousElementSibling?.matches(TITLE_ANCHOR) === true },
    { ui: blockUi, anchor: () => document.querySelector(SIDEBAR_ANCHOR), placed: () => blockUi.shadowHost.parentElement?.matches(SIDEBAR_ANCHOR) === true && blockUi.shadowHost.previousElementSibling === null },
  ];
  const markers = new Map<string, Marker>();

  function view(): TriageView | undefined {
    return current ? allViews[prKey(current)] : undefined;
  }

  async function makeMarker(path: string, kept: Marker) {
    kept.ui = await createShadowRootUi(ctx, {
      name: "corbits-triage-file-note",
      position: "inline",
      anchor: () => noteAnchor(path),
      append: "after",
      onMount(container) {
        container.className = "inline-root";
        container.append(kept.marker.element);
      },
    });
    keepMarkers();
  }

  function keepMarkers() {
    const notes = current && onFilesTab() ? notesByPath(view()) : new Map<string, FileNote[]>();
    for (const [path, { ui }] of markers) if (!notes.has(path) && ui?.shadowHost.isConnected) ui.remove();
    for (const [path, found] of notes) {
      const anchor = noteAnchor(path);
      if (!anchor) continue;
      let kept = markers.get(path);
      if (!kept) {
        kept = { marker: fileMarker() };
        markers.set(path, kept);
        settle(makeMarker(path, kept));
      }
      if (JSON.stringify(kept.shown) !== JSON.stringify(found)) {
        kept.marker.render(path, found);
        kept.shown = found;
      }
      if (kept.ui && !(kept.ui.shadowHost.isConnected && kept.ui.shadowHost.previousElementSibling === anchor)) kept.ui.mount();
    }
    markLines([...notes.values()].flat());
  }

  // GitHub's React page re-renders and drops foreign nodes, so each part is put back whenever it goes missing. A part
  // dropped with its anchor still sits beside it in the detached tree, so being placed counts only while connected.
  function keepMounted() {
    for (const slot of slots) {
      if (!current) {
        if (slot.ui.shadowHost.isConnected) slot.ui.remove();
      } else if (!(slot.ui.shadowHost.isConnected && slot.placed()) && slot.anchor()) slot.ui.mount();
    }
    keepMarkers();
  }

  function render() {
    if (!current) return;
    const key = prKey(current);
    chip.render(view(), allStates[key]);
    block.render(view(), allStates[key]);
    keepMounted();
  }

  // WXT's navigation event comes as GitHub's in-page navigation starts, before the address changes, so it is handled by
  // the address it names; a change of address the event missed is caught on the next frame the page changes.
  let shownHref = "";
  let lastAddress = location.href;
  function onLocation(href: string) {
    if (href === shownHref) return;
    shownHref = href;
    current = prFromUrl(href);
    for (const { ui } of markers.values()) ui?.remove();
    markers.clear();
    if (!current) {
      for (const slot of slots) slot.ui.remove();
      return;
    }
    render();
    send({ type: "triage", pr: current, mode: "if-stale" });
  }

  // GitHub mutates the page constantly; one check per frame, and only on a pull request, is enough.
  let queued = false;
  function onMutation() {
    if (location.href !== lastAddress) {
      lastAddress = location.href;
      onLocation(lastAddress);
    }
    if (!current || queued) return;
    queued = true;
    requestAnimationFrame(function checkMounted() {
      queued = false;
      if (current) keepMounted();
    });
  }
  const observer = new MutationObserver(onMutation);
  observer.observe(document.body, { childList: true, subtree: true });
  ctx.onInvalidated(function stopObserving() {
    observer.disconnect();
  });
  // Runs of other pull requests change these too; only a change to this one's redraws the page's parts.
  function changedHere<T>(before: Record<string, T>, after: Record<string, T>): boolean {
    const key = current && prKey(current);
    return key !== undefined && JSON.stringify(before[key]) !== JSON.stringify(after[key]);
  }
  ctx.onInvalidated(views.watch(function onViews(next) {
    const redraw = changedHere(allViews, next);
    allViews = next;
    if (redraw) render();
  }));
  ctx.onInvalidated(runStates.watch(function onStates(next) {
    const redraw = changedHere(allStates, next);
    allStates = next;
    if (redraw) render();
  }));
  // Read after the watches start, so a run that finishes while the parts mount is not missed.
  [allViews, allStates] = await Promise.all([views.getValue(), runStates.getValue()]);
  ctx.addEventListener(window, "wxt:locationchange", function onNavigate(event) {
    onLocation(event.newUrl.href);
  });
  onLocation(location.href);
}
