import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { createShadowRootUi, type ShadowRootContentScriptUi } from "wxt/utils/content-script-ui/shadow-root";
import { draftsOf, withFooter, type Draft } from "../drafts.ts";
import { errorText } from "../error-text.ts";
import { send, type Reply, type TabRequest } from "../messages.ts";
import { bestDraft, pageActions, type PageAction } from "../page-actions.ts";
import { prFromUrl, prKey, type PrRef } from "../pr.ts";
import { pageReads, type PageReads, type SessionAnswer } from "../session/page-reads.ts";
import {
  actionKey,
  appliedActions,
  autoApply,
  commentFooter,
  liveApplied,
  pageLayout,
  runStates,
  offerKey,
  seedsOffered,
  setApplied,
  setOffered,
  tourPending,
  views,
  type Applied,
  type PageLayout,
  type RunState,
} from "../storage.ts";
import { FRESH_MS, type FileNote, type TriageView } from "../view.ts";
import { applyAction } from "./act.ts";
import { actionBar, type ActionBar, type BarPlace } from "./action-bar.ts";
import { scoreChip } from "./chip.ts";
import { findCommentBox } from "./comment-box.ts";
import { draftMenu } from "./draft-menu.ts";
import { canTriage, openBodyField, openTitleField } from "./editors.ts";
import { fileMarker, markLines, noteAnchor, onFilesTab, type FileMarker } from "./file-notes.ts";
import { pageShows } from "./page-ready.ts";
import { pickerSeeder } from "./pickers.ts";
import { seedNote, titleHint } from "./seed-note.ts";
import { seeder, type SeedSpot } from "./seeds.ts";
import { tour } from "./tour.ts";
import { triageBlock } from "./triage-block.ts";

// After the number in the new pull request page's header (not its sticky copy), then in the classic one's. GitHub's
// CSS-module class names change suffix between deploys, so only their stable stem is matched.
const TITLE_ANCHOR = '[class*="titleWithAction"] > [class*="titleSuffix"], .gh-header-title';
// The pull request's header, under GitHub's own, in the new page and the classic one.
const HEADER_ANCHOR = '[data-component="PageHeader"], #partial-discussion-header';
const SIDEBAR_ANCHOR = "#partial-discussion-sidebar";

/** The menu sits above the whole comment form, so it never lands inside GitHub's editor toolbar. */
function draftsAnchor(): Element | undefined {
  const box = findCommentBox();
  return box?.closest("form") ?? box;
}

function bodyFormAnchor(): Element | undefined {
  const field = openBodyField();
  return field?.closest("form") ?? field;
}

function titleFormAnchor(): Element | undefined {
  const field = openTitleField();
  return field?.closest("form") ?? field;
}

// Runs of different pull requests can read through one tab at once; the oldest reader goes past this many.
const READERS = 4;
const readers = new Map<string, PageReads>();

/** One run's reads share a reader, so a page its paths both need is fetched once. */
async function sessionRead(run: string, path: string, sendResponse: (reply: Reply<SessionAnswer | null>) => void): Promise<void> {
  let reads = readers.get(run);
  if (!reads) {
    reads = pageReads();
    readers.set(run, reads);
    if (readers.size > READERS) readers.delete(readers.keys().next().value!);
  }
  try {
    sendResponse({ ok: true, value: await reads.answer(path) });
  } catch (cause) {
    sendResponse({ ok: false, error: errorText(cause) });
  }
}

/** A part of the page Triage keeps in place: where it goes, whether it is there, and whether this layout wants it. */
type Slot = { ui: ShadowRootContentScriptUi<void>; anchor: () => Element | null | undefined; placed: () => boolean; wanted: () => boolean };

type Derived = { view: TriageView | undefined; drafts: Draft[]; actions: PageAction[]; notes: Map<string, FileNote[]> };

function derive(view: TriageView | undefined): Derived {
  const notes = new Map<string, FileNote[]>();
  for (const note of view?.notes ?? []) notes.set(note.path, [...(notes.get(note.path) ?? []), note]);
  return { view, drafts: view ? draftsOf(view) : [], actions: view ? pageActions(view) : [], notes };
}

/** A file's marker on the Files tab; its shadow root is made once, the first time the file's header shows. */
type Marker = { marker: FileMarker; ui?: ShadowRootContentScriptUi<void>; shown?: FileNote[] };

export async function startContentScript(ctx: ContentScriptContext): Promise<void> {
  let current = prFromUrl(location.href);
  const seeds = seeder(function onUndone() {
    render();
  });
  // Offered in this page already, before storage has heard of it.
  const offeredHere = new Set<string>();
  function wasOffered(key: string): boolean {
    return offeredHere.has(key) || offered[key] !== undefined;
  }
  function offer(key: string) {
    offeredHere.add(key);
    settle(setOffered(key));
  }
  const pickers = pickerSeeder(
    (value) => current !== undefined && wasOffered(offerKey(current, `picker:${value}`)),
    (value) => {
      if (current) offer(offerKey(current, `picker:${value}`));
    },
  );
  const guide = tour();

  // Comments being posted from this page, and posted, by `actionKey`; storage hears of either a moment later.
  const posting = new Set<string>();
  const postedHere = new Set<string>();

  /**
   * Applies an action on this page and records how it went, for the panel and every placement to show. A comment is
   * posted only with `post`, and once: a second click while it posts, or after, does nothing.
   */
  async function apply(pr: PrRef, action: PageAction, post = false): Promise<void> {
    const key = actionKey(pr, action.id);
    if (post && (posting.has(key) || postedHere.has(key) || (applied[key]?.post && applied[key]?.state === "done"))) return;
    if (post) posting.add(key);
    const record = post ? { post } : {};
    try {
      await setApplied(key, { state: "applying", ...record });
      await applyAction(pr, action.kind === "comment" ? { ...action, body: withFooter(action.body ?? "", footer) } : action, seeds, post);
      if (post) postedHere.add(key);
      await setApplied(key, { state: "done", ...record });
    } catch (cause) {
      await setApplied(key, { state: "failed", error: errorText(cause), ...record });
      throw cause;
    } finally {
      posting.delete(key);
    }
  }

  async function answerApply(pr: PrRef, action: PageAction, post: boolean, sendResponse: (reply: Reply<null>) => void): Promise<void> {
    try {
      await apply(pr, action, post);
      sendResponse({ ok: true, value: null });
    } catch (cause) {
      sendResponse({ ok: false, error: errorText(cause) });
    }
  }

  function onTabMessage(request: TabRequest, _sender: Browser.runtime.MessageSender, sendResponse: (reply: Reply<unknown>) => void): boolean {
    if (request.type === "session-read") {
      sessionRead(request.run, request.path, sendResponse);
      return true;
    }
    if (request.type === "apply-action") {
      answerApply(request.pr, request.action, request.post, sendResponse);
      return true;
    }
    if (request.type !== "insert-draft") return false;
    try {
      seeds.insertComposer(request.key, request.title, withFooter(request.body, footer));
      render();
      sendResponse({ ok: true, value: null });
    } catch (cause) {
      sendResponse({ ok: false, error: errorText(cause) });
    }
    return false;
  }

  // First, so a run the panel starts while the page loads can already read through it.
  browser.runtime.onMessage.addListener(onTabMessage);
  ctx.onInvalidated(function stopListening() {
    browser.runtime.onMessage.removeListener(onTabMessage);
  });
  const score = scoreChip();
  const menu = draftMenu({
    insert(draft) {
      if (current) seeds.insertComposer(actionKey(current, draft.id), draft.title, withFooter(draft.body, footer));
      render();
    },
    async post(draft) {
      const action = forView().actions.find((each) => each.id === draft.id);
      if (current && action) await apply(current, action, true);
    },
  });
  const bars = new Map<BarPlace, ActionBar>((["banner", "top-bar", "title"] as const).map((place) => [place, actionBar(place, { apply: onApply, post: onPost })]));
  const block = triageBlock({
    apply: onApply,
    post: onPost,
    undo: undoSeed,
    openPanel() {
      send({ type: "open-panel" });
    },
    rerun() {
      if (current) send({ type: "triage", pr: current, mode: "refetch" });
    },
  });
  const composerNote = seedNote(() => undoSeed("composer"));
  const bodyNote = seedNote(() => undoSeed("body"));
  const hint = titleHint();
  let allViews: Record<string, TriageView> = {};
  let allStates: Record<string, RunState> = {};
  let applied: Record<string, Applied> = {};
  let layout: PageLayout = "sidebar";
  let autoRepos: Record<string, boolean> = {};
  let offered: Record<string, string> = {};
  let pendingTour: string | null = null;
  let footer = true;
  let applying = false;

  function onApply(action: PageAction) {
    if (current) settle(apply(current, action));
  }

  function onPost(action: PageAction) {
    if (current) settle(apply(current, action, true));
  }

  function undoSeed(spot: SeedSpot) {
    seeds.undo(spot);
  }

  async function settle(work: Promise<unknown>) {
    try {
      await work;
    } catch (cause) {
      console.warn(errorText(cause));
    }
  }

  async function shadow(name: string, anchor: () => Element | null | undefined, append: "after" | "before" | "first" | "last", content: HTMLElement, className?: string) {
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

  const chip = await shadow("corbits-triage-chip", () => document.querySelector(TITLE_ANCHOR), "after", score.element, "inline-root");
  const drafts = await shadow("corbits-triage-drafts", draftsAnchor, "before", menu.element);
  const title = await shadow("corbits-triage-title-actions", () => (chip.shadowHost.isConnected ? chip.shadowHost : null), "after", bars.get("title")!.element, "inline-root");
  const sidebar = await shadow("corbits-triage-sidebar", () => document.querySelector(SIDEBAR_ANCHOR), "first", block.element);
  const topBar = await shadow("corbits-triage-top-bar", () => document.querySelector(HEADER_ANCHOR), "before", bars.get("top-bar")!.element);
  const composerSeed = await shadow("corbits-triage-composer-seed", draftsAnchor, "after", composerNote.element);
  const bodySeed = await shadow("corbits-triage-body-seed", bodyFormAnchor, "before", bodyNote.element);
  const titleSeed = await shadow("corbits-triage-title-hint", titleFormAnchor, "after", hint.element);
  // The banner floats over the page's end, so a spacer in the flow keeps the last of it reachable.
  const floating = document.createElement("div");
  const spacer = document.createElement("div");
  spacer.className = "bar-spacer";
  floating.append(spacer, bars.get("banner")!.element);
  const banner = await shadow("corbits-triage-banner", () => document.body, "last", floating);
  const markers = new Map<string, Marker>();

  function view(): TriageView | undefined {
    return current ? allViews[prKey(current)] : undefined;
  }

  // Worked out once per run rather than on every frame GitHub's page mutates.
  let derived = derive(undefined);
  function forView(): Derived {
    const shown = view();
    if (derived.view !== shown) derived = derive(shown);
    return derived;
  }

  function titleRule(): string | undefined {
    return forView().actions.find((action) => action.kind === "edit-title")?.hint;
  }

  /** Whether the chosen placement finds where it goes on this page; when not, the sidebar block shows instead. */
  function placementShows(): boolean {
    switch (layout) {
      case "sidebar":
      case "inline":
      case "banner":
        return true;
      case "top-bar":
        return document.querySelector(HEADER_ANCHOR) !== null;
      case "composer":
        return draftsAnchor() !== undefined;
    }
  }

  const slots: Slot[] = [
    { ui: chip, anchor: () => document.querySelector(TITLE_ANCHOR), placed: () => chip.shadowHost.previousElementSibling?.matches(TITLE_ANCHOR) === true, wanted: () => true },
    { ui: drafts, anchor: draftsAnchor, placed: () => drafts.shadowHost.nextElementSibling === draftsAnchor(), wanted: () => layout === "composer" && placementShows() },
    { ui: title, anchor: () => (chip.shadowHost.isConnected ? chip.shadowHost : null), placed: () => title.shadowHost.previousElementSibling === chip.shadowHost, wanted: () => layout === "inline" },
    { ui: sidebar, anchor: () => document.querySelector(SIDEBAR_ANCHOR), placed: () => sidebar.shadowHost.parentElement?.matches(SIDEBAR_ANCHOR) === true && sidebar.shadowHost.previousElementSibling === null, wanted: () => true },
    { ui: topBar, anchor: () => document.querySelector(HEADER_ANCHOR), placed: () => topBar.shadowHost.nextElementSibling?.matches(HEADER_ANCHOR) === true, wanted: () => layout === "top-bar" && placementShows() },
    { ui: banner, anchor: () => document.body, placed: () => banner.shadowHost.isConnected, wanted: () => layout === "banner" && placementShows() },
    { ui: composerSeed, anchor: draftsAnchor, placed: () => composerSeed.shadowHost.previousElementSibling === draftsAnchor(), wanted: () => seeds.live("composer") !== undefined },
    { ui: bodySeed, anchor: bodyFormAnchor, placed: () => bodySeed.shadowHost.nextElementSibling === bodyFormAnchor(), wanted: () => seeds.live("body") !== undefined },
    { ui: titleSeed, anchor: titleFormAnchor, placed: () => titleSeed.shadowHost.previousElementSibling === titleFormAnchor(), wanted: () => titleRule() !== undefined && openTitleField() !== undefined },
  ];

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

  /** Markers in the Files tab's headers, one per file a failing check points at; GitHub's diff loads files as it scrolls. */
  function keepMarkers() {
    const notes = current && onFilesTab() ? forView().notes : new Map<string, FileNote[]>();
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
      if (kept.shown !== found) {
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
      if (!current || !slot.wanted()) {
        if (slot.ui.shadowHost.isConnected) slot.ui.remove();
      } else if (!(slot.ui.shadowHost.isConnected && slot.placed()) && slot.anchor()) slot.ui.mount();
    }
    keepMarkers();
  }

  function appliedFor(pr: PrRef, actions: PageAction[]): Record<string, Applied | undefined> {
    return Object.fromEntries(actions.map((action) => [action.id, liveApplied(applied[actionKey(pr, action.id)])]));
  }

  /**
   * With auto-apply on for the repository, each action that may run on its own is applied once, one at a time; only
   * from a run as fresh as the background trusts, so an old head's actions never run after a new push.
   */
  async function applyOnOpen(pr: PrRef, shown: TriageView, actions: PageAction[]) {
    const state = allStates[prKey(pr)];
    const confirmed = Date.now() - Date.parse(shown.checkedAt ?? shown.ranAt) < FRESH_MS && state?.running !== true && !state?.error;
    if (applying || !autoRepos[pr.repo] || !confirmed) return;
    applying = true;
    try {
      for (const action of actions.filter((each) => each.auto && each.kind !== "comment" && liveApplied(applied[actionKey(pr, each.id)]) === undefined)) {
        await settle(apply(pr, action));
      }
    } finally {
      applying = false;
    }
  }

  /**
   * The best draft goes into an empty comment box once per pull request, for someone who can triage it (GitHub shows
   * them the label picker), and only while the page shows that pull request.
   */
  function seedComposer(pr: PrRef, actions: PageAction[]): boolean {
    const draft = bestDraft(actions);
    const key = offerKey(pr, "composer");
    if (!draft?.body || wasOffered(key) || !canTriage() || !pageShows(pr)) return false;
    if (!seeds.fillComposer(actionKey(pr, draft.id), draft.title, withFooter(draft.body, footer))) return false;
    offer(key);
    return true;
  }

  function seededNow(pr: PrRef, actions: PageAction[]): Partial<Record<SeedSpot, string>> {
    const out: Partial<Record<SeedSpot, string>> = {};
    for (const spot of ["composer", "body"] as const) {
      const seed = seeds.live(spot);
      const action = seed && actions.find((each) => actionKey(pr, each.id) === seed.key);
      if (action) out[spot] = action.id;
    }
    return out;
  }

  function pickerValues(pr: PrRef, actions: PageAction[]) {
    const owner = pr.repo.split("/")[0];
    return {
      labels: actions.filter((action) => action.kind === "labels").flatMap((action) => action.values),
      reviewers: actions.filter((action) => action.kind === "request-review").flatMap((action) => [...action.values, ...action.teams.map((team) => `${owner}/${team}`)]),
    };
  }

  function startTour(pr: PrRef) {
    // After the page's load, when the browser has restored its scroll, so the first step's scroll is not undone.
    if (pendingTour !== prKey(pr) || guide.active() || !view() || !chip.shadowHost.isConnected || document.readyState !== "complete") return;
    // Started once; reloading the page does not start it again.
    pendingTour = null;
    settle(tourPending.setValue(null));
    const root = sidebar.shadow;
    const inBlock = () => sidebar.shadowHost.isConnected;
    guide.start({
      chip: () => chip.shadow.querySelector(".chip"),
      block: () => (inBlock() ? root.querySelector(".tb-summary") : null),
      actions: () => (inBlock() ? root.querySelector<HTMLElement>(".tb-steps:not([hidden])") : null),
      // The draft in the comment box once Triage put it there, else the drafted comment among the block's steps.
      draft: () => (composerSeed.shadowHost.isConnected ? composerSeed.shadowHost : inBlock() ? root.querySelector('.tb-act[data-kind="comment"]') : null),
      openPanel() {
        send({ type: "open-panel" });
      },
    });
  }

  let lastSeeded = "";
  function render() {
    if (!current) return;
    const key = prKey(current);
    const shown = view();
    const { drafts: drafted, actions } = forView();
    score.render(current, shown, allStates[key]);
    const applies = appliedFor(current, actions);
    menu.render(drafted, shown, applies);
    const state = shown ? { view: shown, actions, applied: applies } : undefined;
    for (const bar of bars.values()) bar.render(state);
    if (shown) seedComposer(current, actions);
    const seededIds = seededNow(current, actions);
    lastSeeded = JSON.stringify(seededIds);
    block.render({ pr: current, view: shown, run: allStates[key], actions, applied: applies, seeded: seededIds });
    composerNote.render(seeds.live("composer"));
    bodyNote.render(seeds.live("body"));
    hint.render(titleRule());
    keepMounted();
    if (shown) settle(applyOnOpen(current, shown, actions));
    guide.refresh();
    startTour(current);
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
    // Moving between pull requests, GitHub may still show the last one's title; the run then reads the title itself.
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
      if (!current) return;
      const { actions } = forView();
      // A field filled or cleared, or an editor opened, changes what the notes and the block say.
      const changed = view() !== undefined && seedComposer(current, actions);
      if (changed || JSON.stringify(seededNow(current, actions)) !== lastSeeded) render();
      else keepMounted();
      if (pageShows(current)) pickers.update(pickerValues(current, actions));
      // The tour waits for the chip, which GitHub's page may render after the run is known.
      if (pendingTour) startTour(current);
    });
  }
  const observer = new MutationObserver(onMutation);
  observer.observe(document.body, { childList: true, subtree: true });
  // Typing changes a field's value without touching the page's nodes, and decides whether a seed is still Triage's.
  ctx.addEventListener(document, "input", onMutation, { capture: true });
  // Opening one of GitHub's pickers may only flip its `open`, which is not a change to the page's nodes either.
  ctx.addEventListener(document, "toggle", onMutation, { capture: true });
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
  ctx.onInvalidated(appliedActions.watch(function onApplied(next) {
    applied = next;
    render();
  }));
  ctx.onInvalidated(pageLayout.watch(function onLayout(next) {
    layout = next;
    render();
  }));
  ctx.onInvalidated(autoApply.watch(function onAuto(next) {
    autoRepos = next;
    render();
  }));
  ctx.onInvalidated(seedsOffered.watch(function onOffered(next) {
    offered = next;
  }));
  ctx.onInvalidated(commentFooter.watch(function onFooter(next) {
    footer = next;
  }));
  // Read after the watches start, so a run that finishes while the chip mounts is not missed. The tour is read only
  // here: it is set before its tab opens, so a tab already showing the pull request does not start it too.
  [allViews, allStates, applied, layout, autoRepos, offered, pendingTour, footer] = await Promise.all([
    views.getValue(),
    runStates.getValue(),
    appliedActions.getValue(),
    pageLayout.getValue(),
    autoApply.getValue(),
    seedsOffered.getValue(),
    tourPending.getValue(),
    commentFooter.getValue(),
  ]);
  ctx.addEventListener(window, "wxt:locationchange", function onNavigate(event) {
    onLocation(event.newUrl.href);
  });
  ctx.addEventListener(window, "load", function startTourAfterLoad() {
    if (current && pendingTour) startTour(current);
  });
  onLocation(location.href);
}
