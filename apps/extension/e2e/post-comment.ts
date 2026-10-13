// Posting a comment as the signed-in person, on a real pull request, signed out: every place a draft shows offers Post
// comment and Edit first, the footer is added unless switched off, and a post is refused signed out, over the person's
// own text and on a second click, and never made by auto-apply. Signed out GitHub shows no comment box, so a stand-in
// with GitHub's composer markup records what its Comment button would submit; nothing reaches GitHub.
// Run it on an open pull request that changes more than one file.
// Run: bun --conditions=intx-src e2e/post-comment.ts <owner/repo> <number> <github token>
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page, type Worker } from "playwright";
import type { CheckPack } from "@corbits/triage-contracts";
import { withFooter } from "../src/drafts.ts";
import { defaultLocalPack } from "../src/local-pack.ts";
import { bestDraft, pageActions, type PageAction } from "../src/page-actions.ts";
import type { Applied, PageLayout } from "../src/storage.ts";
import type { TriageView } from "../src/view.ts";

declare const chrome: {
  storage: { local: { get(key: string | null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  tabs: { query(info: { url: string }): Promise<Array<{ id?: number }>>; sendMessage(tab: number, message: unknown): Promise<unknown> };
};

type Stand = { posted: string[]; closedWith: number };

const [repo, numberArg, token] = process.argv.slice(2);
if (!repo || !numberArg || !token) throw new Error("usage: post-comment.ts <owner/repo> <number> <github token>");
const number = Number(numberArg);
const key = `${repo}#${number}`;
const extension = resolve(import.meta.dir, "../.output/chrome-mv3");
const shots = resolve(import.meta.dir, "../.output/e2e");
const SIGN_IN = "Sign in to GitHub";

// The max files changed rule fails on any pull request of more than one file; its comment Dos give several drafts, beside a
// label that shows auto-apply ran. The rules whose failures add steps of their own are
// off and the default actions left out, so every draft fits the sidebar block whatever else the pull request fails.
const base = defaultLocalPack(repo);
const pack: CheckPack = {
  ...base,
  checks: { ...base.checks, "max-files-changed": { enabled: true, maxFiles: 1 }, "ci-green": { enabled: false }, "linked-issue": { enabled: false }, "no-merge-conflicts": { enabled: false } },
  actions: [
    {
      id: "too-large",
      when: "every",
      checks: ["max-files-changed"],
      branches: {
        no: [
          { kind: "labels", target: { from: "list", labels: ["triage:too-large"] } },
          { kind: "comment", target: { body: "This is only ever posted by a click." } },
          { kind: "comment", target: { body: "Another draft, to post over Triage's own seed." } },
          { kind: "comment", target: { body: "One more draft, to post from the banner." } },
        ],
      },
    },
  ],
};

let failed = false;
function expect(what: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok" : "FAIL"}: ${what}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}

async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function finishedRun(worker: Worker): Promise<TriageView> {
  return until("the run", async function ran() {
    const all = await worker.evaluate(() => chrome.storage.local.get(null));
    const state = (all["run-states"] as Record<string, { running?: boolean; error?: string }> | undefined)?.[key];
    if (state?.error) throw new Error(`triage failed: ${state.error}`);
    return state?.running === false ? (all.views as Record<string, TriageView> | undefined)?.[key] : undefined;
  });
}

async function appliedOf(worker: Worker, id: string): Promise<Applied | undefined> {
  const all = (await worker.evaluate(() => chrome.storage.local.get("applied"))).applied as Record<string, Applied> | undefined;
  return all?.[`${key} ${id}`];
}

async function settled(worker: Worker, id: string): Promise<Applied> {
  return until(`${id} to settle`, async function read() {
    const state = await appliedOf(worker, id);
    return state && state.state !== "applying" ? state : undefined;
  }, 20_000);
}

async function store(worker: Worker, items: Record<string, unknown>): Promise<void> {
  await worker.evaluate((items) => chrome.storage.local.set(items), items);
}

/**
 * GitHub's comment form as it renders signed in: the composer's box, Close with comment, and Comment, disabled until
 * the box has text. Submitting records the text and empties the box a moment later, as GitHub does once it is saved.
 * `picker` adds the sidebar's label picker, which tells Triage the person can triage, so it seeds the box.
 */
async function composer(page: Page, picker: boolean): Promise<void> {
  await page.evaluate((picker) => {
    const stand = { posted: [] as string[], closedWith: 0 };
    (window as unknown as { stand: Stand }).stand = stand;
    if (picker) {
      const labels = document.createElement("form");
      labels.setAttribute("aria-label", "Select labels");
      document.querySelector("#partial-discussion-sidebar")?.append(labels);
    }
    const form = document.createElement("form");
    form.className = "stand-in-composer";
    const box = document.createElement("textarea");
    box.setAttribute("aria-label", "Markdown value");
    box.style.cssText = "display:block;width:900px;height:120px;font:13px/1.5 monospace";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close with comment";
    close.addEventListener("click", () => stand.closedWith++);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.innerHTML = "<span>Comment</span>";
    submit.disabled = true;
    box.addEventListener("input", () => (submit.disabled = !box.value.trim()));
    form.addEventListener("submit", function post(event) {
      event.preventDefault();
      stand.posted.push(box.value);
      setTimeout(function saved() {
        box.value = "";
        submit.disabled = true;
      }, 300);
    });
    const row = document.createElement("div");
    row.append(close, submit);
    form.append(box, row);
    const frame = document.createElement("div");
    frame.style.cssText = "max-width:900px;margin:24px auto";
    frame.append(form);
    document.querySelector("main")?.prepend(frame);
  }, picker);
}

async function stand(page: Page): Promise<Stand> {
  return page.evaluate(() => (window as unknown as { stand: Stand }).stand);
}

async function boxValue(page: Page): Promise<string> {
  return page.locator(".stand-in-composer textarea").inputValue();
}

/** A fresh page: nothing posted from it yet, the stand-in composer in place, the drafts' records cleared. */
async function reload(page: Page, worker: Worker, picker = false): Promise<void> {
  await store(worker, { applied: {}, "seeds-offered": {} });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("corbits-triage-sidebar .tb-draft").first().waitFor({ state: "visible" });
  await composer(page, picker);
}

// Dos are titled by their action, so drafts are told apart by their place, in the order every part lists them.
let comments: PageAction[] = [];

function draftIn(page: Page, action: PageAction) {
  return page.locator("corbits-triage-sidebar .tb-draft").nth(comments.indexOf(action));
}

await mkdir(shots, { recursive: true });
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "triage-post-")), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await store(worker, { onboarded: true, packs: { [repo]: pack }, "github-token": token });
  const page = await context.newPage();
  await page.goto(`https://github.com/${repo}/pull/${number}`, { waitUntil: "domcontentloaded" });
  const view = await finishedRun(worker);
  comments = pageActions(view).filter((action) => action.kind === "comment");
  if (comments.length < 3) throw new Error(`the run drafts ${comments.length} comments; pass a pull request that changes more than one file`);
  const [first, second, third] = comments as [PageAction, PageAction, PageAction];
  const text = (action: PageAction) => withFooter(action.body ?? "", true);

  // Every draft in the sidebar block offers Post comment, GitHub's primary look, and Edit first.
  await page.locator("corbits-triage-sidebar .tb-draft").first().waitFor({ state: "visible" });
  const buttons = await draftIn(page, first).locator("button").allInnerTexts();
  const primary = await draftIn(page, first).locator("button").first().getAttribute("data-primary");
  expect("the sidebar block offers Post comment, then Edit first", buttons.join("|") === "Post comment|Edit first" && primary === "true", buttons.join(", "));
  expect("the footer ends the comment", text(first).endsWith("\n\n---\n<sub>Generated by Corbits Triage</sub>") && withFooter(text(first), true) === text(first));

  // Signed out GitHub shows no comment box, so a post is refused with the sign-in message.
  await draftIn(page, first).getByRole("button", { name: /^Post comment/ }).click();
  const signedOut = await settled(worker, first.id);
  expect("signed out, a post is refused", signedOut.state === "failed" && signedOut.post === true && signedOut.error?.includes(SIGN_IN) === true, signedOut.error);

  // Auto-apply on: the automatic label is tried, and no comment, automatic or not, is posted or put in the box.
  // Switched on away from the page, so only the page opened afterwards applies anything.
  await page.goto("about:blank");
  await store(worker, { "auto-apply": { [repo]: true }, applied: {} });
  await page.goto(`https://github.com/${repo}/pull/${number}`, { waitUntil: "domcontentloaded" });
  await until("auto-apply to try the label", async function tried() {
    const all = Object.keys(((await worker.evaluate(() => chrome.storage.local.get("applied"))).applied ?? {}) as Record<string, Applied>);
    return all.length ? all : undefined;
  });
  await Bun.sleep(1500);
  const tried = Object.keys(((await worker.evaluate(() => chrome.storage.local.get("applied"))).applied ?? {}) as Record<string, Applied>);
  const commentTried = tried.some((each) => comments.some((action) => each === `${key} ${action.id}`));
  // Every attempt, posted or put in the box, leaves a record.
  expect("auto-apply never posts or drafts a comment", !commentTried, `${tried.length} tried`);
  await page.goto("about:blank");
  await store(worker, { "auto-apply": {} });
  await page.goto(`https://github.com/${repo}/pull/${number}`, { waitUntil: "domcontentloaded" });

  // Edit first fills the box with the footer and submits nothing; switched off, the footer is left out.
  await reload(page, worker);
  await draftIn(page, first).getByRole("button", { name: /^Edit first/ }).click();
  await until("the draft in the box", async () => ((await boxValue(page)) ? true : undefined));
  expect("Edit first puts the draft and footer in the box, unposted", (await boxValue(page)) === text(first) && (await stand(page)).posted.length === 0);
  await page.locator(".stand-in-composer textarea").fill("");
  await store(worker, { commentFooter: false });
  await Bun.sleep(300);
  await draftIn(page, first).getByRole("button", { name: /^Edit first/ }).click();
  await until("the draft in the box", async () => ((await boxValue(page)) ? true : undefined));
  expect("with the footer off, Edit first puts the draft alone", (await boxValue(page)) === first.body);
  await store(worker, { commentFooter: true });

  // The person's own text in the box: the post is refused and their text is left as it was.
  await page.locator(".stand-in-composer textarea").fill("My own words");
  await draftIn(page, second).getByRole("button", { name: /^Post comment/ }).click();
  const own = await settled(worker, second.id);
  expect("over the person's own text, a post is refused", own.state === "failed" && /your own text/.test(own.error ?? "") && (await boxValue(page)) === "My own words" && (await stand(page)).posted.length === 0, own.error);

  // Posted through GitHub's Comment button, once, with the footer; never through Close with comment.
  await reload(page, worker);
  await draftIn(page, first).getByRole("button", { name: /^Post comment/ }).click();
  const posted = await settled(worker, first.id);
  const afterPost = await stand(page);
  expect("Post comment submits GitHub's form once, with the footer", posted.state === "done" && posted.post === true && afterPost.posted.length === 1 && afterPost.posted[0] === text(first) && afterPost.closedWith === 0, posted.error);
  const shown = await until("the block to say posted", async () => ((await draftIn(page, first).locator("button").allInnerTexts()).join("|") === "Posted" ? true : undefined), 5000);
  expect("the block shows it posted, with no Edit first", shown);
  await page.locator("corbits-triage-sidebar .tb-steps").screenshot({ path: join(shots, "post-comment-block.png") });

  // A double click posts once, and the panel asking again afterwards posts nothing more.
  await page.evaluate((at) => {
    const post = document.querySelector("corbits-triage-sidebar")!.shadowRoot!.querySelectorAll(".tb-draft")[at]!.querySelector<HTMLButtonElement>("button")!;
    post.click();
    post.click();
  }, comments.indexOf(second));
  await settled(worker, second.id);
  await worker.evaluate(async ({ url, pr, action }) => {
    const [tab] = await chrome.tabs.query({ url });
    await Promise.all([1, 2].map(() => chrome.tabs.sendMessage(tab!.id!, { type: "apply-action", pr, action, post: true })));
  }, { url: page.url(), pr: { repo, number }, action: second });
  const twice = (await stand(page)).posted.filter((each) => each === text(second)).length;
  expect("a double click, then the panel twice, post once", twice === 1, `${twice} posts`);

  // Triage's own seed in the box is not the person's text: a post replaces it.
  await reload(page, worker, true);
  const best = bestDraft(pageActions(view))!;
  await until("the seeded draft", async () => ((await boxValue(page)) === text(best) ? true : undefined), 10_000);
  await draftIn(page, third).getByRole("button", { name: /^Post comment/ }).click();
  const overSeed = await settled(worker, third.id);
  const seededPost = await stand(page);
  expect("over Triage's own seed, the post goes through with only this draft", overSeed.state === "done" && seededPost.posted.length === 1 && seededPost.posted[0] === text(third), overSeed.error);

  // The drafts menu above the comment box, then the banner, post the same way.
  async function layout(value: PageLayout) {
    await store(worker, { "page-layout": value });
  }
  await reload(page, worker);
  await layout("composer");
  await page.locator("corbits-triage-drafts .drafts-toggle").click();
  await page.locator("corbits-triage-drafts .draft-post").first().waitFor({ state: "visible" });
  await page.locator("corbits-triage-drafts .drafts-panel").screenshot({ path: join(shots, "post-comment-menu.png") });
  const menuButtons = await page.locator("corbits-triage-drafts .draft-item").first().locator("button").allInnerTexts();
  await page.locator("corbits-triage-drafts .draft-item").nth(comments.indexOf(second)).getByRole("button", { name: /^Post comment/ }).click();
  const fromMenu = await settled(worker, second.id);
  expect("the drafts menu offers both and posts", menuButtons.join("|") === "Post comment|Edit first" && fromMenu.state === "done" && (await stand(page)).posted[0] === text(second), fromMenu.error);

  await reload(page, worker);
  await layout("banner");
  const last = comments.at(-1)!;
  const pair = page.locator("corbits-triage-banner .bar-pair").nth(comments.length - 1);
  const bannerPost = pair.locator(".bar-action[data-primary='true']");
  await bannerPost.waitFor({ state: "visible" });
  const bannerEdit = await pair.locator("button").allInnerTexts();
  await page.locator("corbits-triage-banner .bar").screenshot({ path: join(shots, "post-comment-banner.png") });
  await bannerPost.click();
  const fromBanner = await settled(worker, last.id);
  expect("the banner offers both and posts", bannerEdit.at(-1) === "Edit first" && fromBanner.state === "done" && (await stand(page)).posted[0] === text(last), fromBanner.error);
  await layout("sidebar");

  // The workspace, the side panel's actions in a full tab, posts on the GitHub tab.
  await reload(page, worker);
  const extensionId = new URL(worker.url()).host;
  const workspace = await context.newPage();
  await workspace.goto(`chrome-extension://${extensionId}/workspace.html#${encodeURIComponent(key)}`);
  const row = workspace.locator(".action-row").filter({ has: workspace.locator("blockquote", { hasText: first.body }) }).first();
  await row.getByRole("button", { name: "Post comment" }).waitFor({ state: "visible" });
  const rowButtons = await row.locator(".row button").allInnerTexts();
  await row.screenshot({ path: join(shots, "post-comment-workspace.png") });
  await row.getByRole("button", { name: "Post comment" }).click();
  const fromWorkspace = await settled(worker, first.id);
  await row.getByText("Posted on the pull request").waitFor({ state: "visible", timeout: 5000 });
  expect("the workspace offers both, posts, and says so", rowButtons.join("|") === "Post comment|Edit first" && fromWorkspace.state === "done" && (await stand(page)).posted[0] === text(first), fromWorkspace.error);
  await workspace.close();
} finally {
  await context.close();
}
if (failed) process.exitCode = 1;
