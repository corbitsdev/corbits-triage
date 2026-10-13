// A step applies on an open pull request whatever GitHub's page names it with: the signed-in page's header and title,
// nothing at all, or another pull request's title left over from in-page navigation. Signed out there is no title
// editor, so a stand-in for GitHub's Edit records the click; the step is clicked from the sidebar block and through
// the side panel's message.
// Run: bun --conditions=intx-src e2e/page-ready.ts <owner/repo> <number> <github token>
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page, type Worker } from "playwright";
import { parseCheckPack } from "@corbits/triage-contracts";
import { defaultLocalPack } from "../src/local-pack.ts";
import type { Applied } from "../src/storage.ts";
import type { TriageView } from "../src/view.ts";

declare const chrome: {
  storage: { local: { get(key: string | null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  tabs: { query(info: { url: string }): Promise<Array<{ id?: number }>>; sendMessage(tab: number, message: unknown): Promise<unknown> };
};

const [repo, numberArg, token] = process.argv.slice(2);
if (!repo || !numberArg || !token) throw new Error("usage: page-ready.ts <owner/repo> <number> <github token>");
const number = Number(numberArg);
const key = `${repo}#${number}`;
const extension = resolve(import.meta.dir, "../.output/chrome-mv3");
// Under the page's own wait for it to show the pull request, so a page that names it acts at once.
const PROMPT_MS = 1000;

const base = defaultLocalPack(repo);
const pack = parseCheckPack({ ...base, custom: [...base.custom, { id: "custom-9", name: "Ticket in the title", group: "pull-request", kind: "rule", rule: "title-pattern", pattern: "^\\[NEVER-\\d+\\]" }] }, repo);
if (!pack) throw new Error("the test pack does not parse");

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

/**
 * GitHub's header as the page names the pull request: `signed-in` as the signed-in React page renders it, `header`
 * the same with a title that does not name it, `none` with
 * nothing naming it, `stale` still titled with another pull request. A stand-in Edit records when it is clicked.
 */
async function markup(page: Page, how: "signed-in" | "header" | "none" | "stale"): Promise<void> {
  await page.evaluate(({ how, number, repo }) => {
    for (const marker of document.querySelectorAll('[data-component="PH_Title"], [class*="titleSuffix"], .gh-header-number, .js-title-edit-button')) marker.remove();
    document.title = how === "signed-in" ? `Some title by someone · Pull Request #${number} · ${repo} · GitHub` : how === "stale" ? `Other · Pull Request #${number + 1} · ${repo} · GitHub` : "GitHub";
    if (how === "signed-in" || how === "header") {
      const heading = document.createElement("h1");
      heading.setAttribute("data-component", "PH_Title");
      heading.innerHTML = `<span class="markdown-title">Some title</span><span class="sr-only"> - #<!-- -->${number}</span>`;
      const suffix = document.createElement("span");
      suffix.className = "PullRequestHeader-module__titleSuffix__abc12";
      suffix.innerHTML = `<span aria-hidden="true">#<!-- -->${number}</span><button>Copy link</button>`;
      document.body.prepend(heading, suffix);
    }
    const edit = document.createElement("button");
    edit.className = "js-title-edit-button";
    edit.hidden = true;
    edit.addEventListener("click", function record() {
      (window as unknown as { titleEditAt: number }).titleEditAt = performance.now();
    });
    document.body.append(edit);
    (window as unknown as { titleEditAt?: number }).titleEditAt = undefined;
  }, { how, number, repo });
}

async function applied(worker: Worker): Promise<Applied | undefined> {
  const all = (await worker.evaluate(() => chrome.storage.local.get("applied"))).applied as Record<string, Applied> | undefined;
  return Object.entries(all ?? {}).find(([each]) => each.startsWith(key) && each.endsWith(":edit-title"))?.[1];
}

/** Clicks the step the way `from` does and returns how long the page took to act and how the step ended. */
async function act(page: Page, worker: Worker, from: "block" | "panel", action: unknown): Promise<{ ms: number; result?: Applied }> {
  await worker.evaluate(() => chrome.storage.local.set({ applied: {} }));
  await page.waitForFunction(() => document.querySelector("corbits-triage-sidebar")?.shadowRoot?.querySelector(".tb-act[data-kind='edit-title']:not([disabled])"));
  const start = await page.evaluate(() => performance.now());
  if (from === "block") await page.locator("corbits-triage-sidebar .tb-act[data-kind='edit-title']").click();
  else {
    await worker.evaluate(async ({ url, pr, action }) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.tabs.sendMessage(tab!.id!, { type: "apply-action", pr, action, post: false });
    }, { url: page.url(), pr: { repo, number }, action });
  }
  const result = await until("the step to settle", async function settled() {
    const state = await applied(worker);
    return state && state.state !== "applying" ? state : undefined;
  }, 10_000);
  const at = await page.evaluate(() => (window as unknown as { titleEditAt?: number }).titleEditAt);
  return { ms: at === undefined ? Number.NaN : at - start, result };
}

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "triage-page-ready-")), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(({ repo, pack, token }) => chrome.storage.local.set({ onboarded: true, packs: { [repo]: pack }, "github-token": token }), { repo, pack, token });
  const page = await context.newPage();
  await page.goto(`https://github.com/${repo}/pull/${number}`, { waitUntil: "domcontentloaded" });
  const view = await finishedRun(worker);
  const step = (view.suggested ?? []).find((each) => each.kind === "edit-title");
  if (!step) throw new Error("the run suggests no title edit");
  await page.locator("corbits-triage-sidebar .tb").waitFor({ state: "visible" });

  for (const how of ["signed-in", "header", "none", "stale"] as const) {
    for (const from of ["block", "panel"] as const) {
      await markup(page, how);
      const { ms, result } = await act(page, worker, from, step);
      const acted = !Number.isNaN(ms) && result?.state === "done";
      const named = how === "signed-in" || how === "header";
      const prompt = !named || ms < PROMPT_MS;
      expect(`${how} markup, from the ${from}: GitHub's Edit is clicked${named ? " at once" : ""}`, acted && prompt, `${Math.round(ms)} ms, ${result?.state}${result?.error ? `: ${result.error}` : ""}`);
    }
  }
} finally {
  await context.close();
}
if (failed) process.exitCode = 1;
