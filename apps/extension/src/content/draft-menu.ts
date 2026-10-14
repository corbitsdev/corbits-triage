import type { Draft } from "../drafts.ts";
import type { Applied } from "../storage.ts";
import { nextStep, stateName, toneOf, type TriageView } from "../view.ts";
import { errorText } from "../error-text.ts";

export type DraftMenu = { element: HTMLElement; render(drafts: Draft[], view: TriageView | undefined, applied: Record<string, Applied | undefined>): void };

export type DraftHandlers = { insert(draft: Draft): void; post(draft: Draft): Promise<void> };

const NOTE_MS = 5000;
const STEPS: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };

/**
 * "Triage drafts" above GitHub's comment box: preview a draft, then post it as yourself, or put it in the box to edit
 * first. Putting it in adds to what is already typed and never submits.
 */
export function draftMenu(handlers: DraftHandlers): DraftMenu {
  const element = document.createElement("div");
  element.className = "drafts";
  element.innerHTML = `<div class="drafts-bar"><p class="drafts-summary"></p><p class="drafts-note" role="status"></p><button type="button" class="drafts-toggle" aria-expanded="false" aria-controls="corbits-triage-drafts-panel"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12M2 8h12M2 12.5h7"/></svg>Triage drafts <span class="drafts-count"></span><svg class="caret" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button></div><div class="drafts-panel" id="corbits-triage-drafts-panel" hidden><ul class="drafts-items" aria-label="Drafts from this pull request's rules"></ul><div class="drafts-preview"><p class="drafts-preview-label">Preview</p><p class="drafts-preview-body" id="corbits-triage-draft-preview" tabindex="0"></p></div><div class="drafts-foot"><p class="drafts-hint">Post comment posts it as you. Edit first puts it in the comment box.</p></div><p class="drafts-error" role="alert" hidden></p></div>`;
  const toggle = element.querySelector<HTMLButtonElement>(".drafts-toggle")!;
  const count = element.querySelector<HTMLElement>(".drafts-count")!;
  const panel = element.querySelector<HTMLElement>(".drafts-panel")!;
  const items = element.querySelector<HTMLElement>(".drafts-items")!;
  const preview = element.querySelector<HTMLElement>(".drafts-preview-body")!;
  const note = element.querySelector<HTMLElement>(".drafts-note")!;
  const error = element.querySelector<HTMLElement>(".drafts-error")!;
  const summary = element.querySelector<HTMLElement>(".drafts-summary")!;
  let shown: Draft[] = [];
  // Each draft's two buttons, kept across renders so focus stays put while a post goes through.
  const rows = new Map<string, { post: HTMLButtonElement; edit: HTMLButtonElement }>();
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  function buttons(): HTMLButtonElement[] {
    return [...items.querySelectorAll<HTMLButtonElement>("button:not([hidden], :disabled)")];
  }

  function setOpen(open: boolean) {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) buttons()[0]?.focus();
  }

  function showPreview(draft: Draft) {
    preview.textContent = draft.body;
  }

  function tell(text: string) {
    clearTimeout(noteTimer);
    note.textContent = text;
    noteTimer = setTimeout(function clearNote() {
      note.textContent = "";
    }, NOTE_MS);
  }

  function fail(cause: unknown) {
    error.textContent = errorText(cause);
    error.hidden = false;
  }

  function insert(draft: Draft) {
    error.hidden = true;
    try {
      handlers.insert(draft);
    } catch (cause) {
      fail(cause);
      return;
    }
    setOpen(false);
    tell(`Inserted "${draft.title}". Edit it, then press Comment.`);
  }

  async function post(draft: Draft) {
    error.hidden = true;
    try {
      await handlers.post(draft);
    } catch (cause) {
      fail(cause);
      return;
    }
    tell(`Posted "${draft.title}".`);
  }

  toggle.addEventListener("click", function onToggle() {
    error.hidden = true;
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });
  element.addEventListener("keydown", function onKey(event) {
    if (event.key === "Escape" && !panel.hidden) {
      event.stopPropagation();
      setOpen(false);
      toggle.focus();
      return;
    }
    const step = STEPS[event.key];
    const list = buttons();
    const at = list.indexOf(event.target as HTMLButtonElement);
    if (step === undefined || at < 0) return;
    event.preventDefault();
    list[(at + step + list.length) % list.length]!.focus();
  });
  element.addEventListener("focusout", function onFocusOut(event) {
    if (!element.contains(event.relatedTarget as Node | null)) setOpen(false);
  });

  function renderSummary(view: TriageView | undefined) {
    if (!view) {
      summary.replaceChildren();
      return;
    }
    const score = document.createElement("b");
    score.className = "drafts-score";
    score.textContent = view.readiness?.toString() ?? "–";
    const state = document.createElement("b");
    state.textContent = stateName(view);
    summary.dataset.tone = toneOf(view);
    summary.title = nextStep(view);
    summary.replaceChildren(score, " ", state, ` · ${nextStep(view)}`);
  }

  function button(className: string, text: string, label: string, draft: Draft, onClick: () => void): HTMLButtonElement {
    const made = document.createElement("button");
    made.type = "button";
    made.className = className;
    made.textContent = text;
    made.setAttribute("aria-label", label);
    made.setAttribute("aria-describedby", "corbits-triage-draft-preview");
    made.addEventListener("focus", () => showPreview(draft));
    made.addEventListener("click", onClick);
    return made;
  }

  function item(draft: Draft): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "draft-item";
    li.addEventListener("mouseenter", () => showPreview(draft));
    const text = document.createElement("div");
    text.className = "draft-text";
    const title = document.createElement("b");
    title.textContent = draft.title;
    const why = document.createElement("small");
    why.textContent = draft.why;
    text.append(title, why);
    const postButton = button("draft-post", "Post comment", `Post comment: ${draft.title}`, draft, () => post(draft));
    const edit = button("draft-edit", "Edit first", `Edit first: ${draft.title}`, draft, () => insert(draft));
    const actions = document.createElement("div");
    actions.className = "draft-buttons";
    actions.append(postButton, edit);
    li.append(text, actions);
    rows.set(draft.id, { post: postButton, edit });
    return li;
  }

  function renderApplied(applied: Record<string, Applied | undefined>) {
    for (const [id, { post: postButton, edit }] of rows) {
      const record = applied[id];
      const posted = record?.post === true && record.state === "done";
      const busy = record?.state === "applying";
      postButton.textContent = posted ? "Posted" : busy && record.post ? "Posting…" : "Post comment";
      postButton.disabled = posted || busy;
      edit.disabled = busy;
      edit.hidden = posted;
    }
  }

  function render(drafts: Draft[], view: TriageView | undefined, applied: Record<string, Applied | undefined>) {
    renderSummary(view);
    toggle.hidden = drafts.length === 0;
    // Storage changes often re-render the page's parts; the same drafts keep the menu, its focus and its preview.
    if (JSON.stringify(drafts) !== JSON.stringify(shown)) {
      shown = drafts;
      rows.clear();
      count.textContent = String(drafts.length);
      items.replaceChildren(...drafts.map(item));
      if (drafts[0]) showPreview(drafts[0]);
    }
    renderApplied(applied);
  }

  return { element, render };
}
