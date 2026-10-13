import { githubHref } from "../github-href.ts";
import type { PageAction } from "../page-actions.ts";
import { prFromUrl, prKey, type PrRef } from "../pr.ts";
import { actionKey } from "../storage.ts";
import { findCommentBox, setBox } from "./comment-box.ts";
import { editBody, markReady, openBodyField, SIGN_IN } from "./editors.ts";
import { untilPageShows } from "./page-ready.ts";
import type { Seeder } from "./seeds.ts";

/**
 * Applies a suggested action as the person signed in to GitHub, through GitHub's own page: the sidebar's label,
 * assignee and reviewer forms with the CSRF token GitHub rendered into them, the page's own close, edit and ready
 * buttons, the comment box, posted through GitHub's own Comment button only when the person asks, and the description
 * editor, which is filled and never submitted.
 */

// The sidebar form behind each picker, by the label GitHub gives it.
const FORMS: Record<"labels" | "assign" | "request-review", string> = {
  labels: "Select labels",
  assign: "Select assignees",
  "request-review": "Select reviewers",
};

const HEADERS = { accept: "application/json", "x-requested-with": "XMLHttpRequest", "github-verified-fetch": "true" };

async function sidebar(pr: PrRef): Promise<Document> {
  const res = await fetch(`/${pr.repo}/pull/${pr.number}/partials/sidebar`, { headers: HEADERS, cache: "no-store" });
  if (!res.ok) throw new Error(`GitHub's sidebar did not load (${res.status}).`);
  const payload = ((await res.json()) as { payload?: Record<string, { value?: unknown }> }).payload;
  const html = Object.values(payload ?? {})[0]?.value;
  if (typeof html !== "string") throw new Error("GitHub's sidebar came back empty.");
  return new DOMParser().parseFromString(html, "text/html");
}

/** What the sidebar shows as already set for the kind of action. */
function currentValues(doc: Document, kind: keyof typeof FORMS): string[] {
  if (kind === "labels") return [...doc.querySelectorAll(".js-issue-labels [data-name]")].map((node) => node.getAttribute("data-name")!);
  if (kind === "assign") return [...doc.querySelectorAll(".js-issue-assignees [data-assignee-name]")].map((node) => node.getAttribute("data-assignee-name")!);
  return [...doc.querySelectorAll('[id^="awaiting-review-"]')].map((node) => node.id.slice("awaiting-review-".length));
}

function same(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

function boxesOf(menu: ParentNode): HTMLInputElement[] {
  return [...menu.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}

/** The names a picker row carries, exactly: its box's value and the name GitHub puts on the row. */
function namesOf(box: HTMLInputElement): string[] {
  const row = box.closest("label, [role^='menuitem'], li") ?? box.parentElement;
  const named = row?.querySelector("[data-name], [data-assignee-name], [data-login]");
  return [box.value, ...["data-name", "data-assignee-name", "data-login"].flatMap((attribute) => named?.getAttribute(attribute) ?? [])];
}

/** The picker's checkbox for a label name, login or team, matched exactly; a partial match could drop a value already set. */
export function checkboxFor(menu: ParentNode, value: string): HTMLInputElement | undefined {
  return boxesOf(menu).find((box) => namesOf(box).some((name) => same(name, value)));
}

async function menuOf(form: HTMLFormElement): Promise<ParentNode> {
  const src = form.querySelector("include-fragment[src], details-menu[src]")?.getAttribute("src");
  if (!src) return form;
  const res = await fetch(src, { headers: { accept: "text/html", "x-requested-with": "XMLHttpRequest" }, cache: "no-store" });
  if (!res.ok) throw new Error(`GitHub's picker did not load (${res.status}).`);
  return new DOMParser().parseFromString(await res.text(), "text/html");
}

/**
 * Submits the sidebar picker's form with everything already set plus the action's values, as the picker would when
 * closed. GitHub replaces the whole set from this form, so a value already set that cannot be found in the picker stops
 * it before anything is sent; the sidebar is read again afterwards to confirm.
 */
async function applyThroughSidebar(pr: PrRef, kind: keyof typeof FORMS, action: PageAction): Promise<void> {
  const wanted = kind === "request-review" ? [...action.values, ...action.teams.map((team) => `${pr.repo.split("/")[0]}/${team}`)] : action.values;
  const doc = await sidebar(pr);
  const current = currentValues(doc, kind);
  const missing = wanted.filter((value) => !current.some((each) => same(each, value)));
  if (!missing.length) return;
  const form = doc.querySelector<HTMLFormElement>(`form[aria-label="${FORMS[kind]}"]`);
  const token = form?.querySelector<HTMLInputElement>('input[name="authenticity_token"]');
  if (!form || !token) throw new Error(SIGN_IN);
  const menu = await menuOf(form);
  // The picker's own checked rows must agree with the sidebar, or the set sent back could drop something.
  const checked = boxesOf(menu).filter((box) => box.checked);
  const agrees = checked.length === current.length && current.every((value) => checked.some((box) => namesOf(box).some((name) => same(name, value))));
  if (checked.length && !agrees) throw new Error("GitHub's picker and sidebar disagree on what is set, so nothing was changed.");
  const body = new URLSearchParams();
  for (const input of form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')) body.append(input.name, input.value);
  for (const value of [...current, ...missing]) {
    const box = checkboxFor(menu, value);
    if (!box) throw new Error(`${value} is not in GitHub's picker here, so nothing was changed.`);
    body.append(box.name, box.value);
  }
  const res = await fetch(form.getAttribute("action")!, { method: "POST", body, headers: { accept: "text/html", "x-requested-with": "XMLHttpRequest" } });
  if (!res.ok) throw new Error(res.status === 403 || res.status === 422 ? SIGN_IN : `GitHub answered ${res.status}.`);
  const after = currentValues(await sidebar(pr), kind);
  const unset = wanted.filter((value) => !after.some((each) => same(each, value)));
  if (unset.length) throw new Error(`GitHub did not set ${unset.join(", ")}.`);
  const dropped = current.filter((value) => !after.some((each) => same(each, value)));
  if (dropped.length) throw new Error(`GitHub no longer shows ${dropped.join(", ")}; check the pull request's sidebar.`);
}

/** GitHub's own close button, under the comment box; only while it closes without posting what the box holds. */
function closeButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => /^close pull request$/i.test(button.textContent?.trim() ?? "") && !button.disabled);
}

// GitHub swaps its editor in after the click, and enables its Comment button once it hears the box change.
const EDITOR_WAIT_MS = 3000;
// GitHub empties its comment box once the comment is saved.
const POSTED_WAIT_MS = 15_000;
const POLL_MS = 100;

async function until<T>(find: () => T | undefined, ms: number, failure: string): Promise<T> {
  const end = Date.now() + ms;
  for (let found = find(); ; found = find()) {
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(failure);
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

/** GitHub's own Comment button for the box: the nearest one around it, never "Close with comment". */
function commentButton(box: HTMLTextAreaElement): HTMLButtonElement | undefined {
  for (let scope = box.parentElement; scope; scope = scope.parentElement) {
    const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((each) => /^comment$/i.test(each.textContent?.trim() ?? ""));
    if (button) return button.disabled ? undefined : button;
  }
  return undefined;
}

/**
 * Posts the comment as the signed-in person the way they would: in GitHub's comment box, with its Comment button. The
 * box may hold Triage's own draft, which this replaces; words the person wrote are never posted or lost.
 */
async function postComment(seeds: Seeder, text: string): Promise<void> {
  const box = findCommentBox();
  if (!box) throw new Error(`Open the Conversation tab. ${SIGN_IN}`);
  const held = box.value.trim();
  if (held && held !== seeds.live("composer")?.added.trim()) throw new Error("The comment box has your own text. Post or clear it first, so it is not posted with this.");
  setBox(box, text);
  const button = await until(() => commentButton(box), EDITOR_WAIT_MS, "GitHub's Comment button is not here. Post it from the comment box yourself.");
  button.click();
  await until(() => (findCommentBox()?.value.trim() === text.trim() ? undefined : true), POSTED_WAIT_MS, "GitHub did not confirm the comment. Check the conversation before posting again.");
}

/** `post` posts a comment rather than putting it in the comment box; nothing else is posted. */
export async function applyAction(pr: PrRef, action: PageAction, seeds: Seeder, post: boolean): Promise<void> {
  const shown = prFromUrl(location.href);
  if (!shown || prKey(shown) !== prKey(pr)) throw new Error("This tab now shows another page. Open the pull request and try again.");
  await untilPageShows(pr);
  switch (action.kind) {
    case "comment":
      if (post) await postComment(seeds, action.body ?? "");
      else seeds.insertComposer(actionKey(pr, action.id), action.title, action.body ?? "");
      return;
    case "edit-body":
      editBody();
      await until(openBodyField, EDITOR_WAIT_MS, "GitHub's description editor did not open.");
      seeds.appendBody(actionKey(pr, action.id), action.title, action.body ?? "", true);
      return;
    case "ready":
      markReady();
      return;
    case "link": {
      const href = githubHref(action.href);
      if (!href) throw new Error("Triage only opens pages on github.com.");
      location.assign(href);
      return;
    }
    case "close": {
      // With text in the box GitHub's button turns into "Close with comment", which would post it.
      if (findCommentBox()?.value.trim()) throw new Error("Clear the comment box first, so closing posts nothing.");
      const button = closeButton();
      if (!button) throw new Error(`Open the Conversation tab. ${SIGN_IN}`);
      button.click();
      return;
    }
    case "labels":
    case "assign":
    case "request-review":
      await applyThroughSidebar(pr, action.kind, action);
  }
}
