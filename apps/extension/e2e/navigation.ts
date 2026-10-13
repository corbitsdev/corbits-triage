// Triage appears on a pull request however GitHub gets there without a reload: from the pull request list, from a
// pull request's Files tab back to its Conversation, from one pull request to another, and back through history.
// Run: bun e2e/navigation.ts [owner/repo]
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";

declare const chrome: { storage: { local: { get(key: string): Promise<Record<string, any>>; set(items: Record<string, unknown>): Promise<void> } } };

const repo = process.argv[2] ?? "corbitsdev/corbits-triage";
const extension = resolve(import.meta.dir, "../.output/chrome-mv3");
const WAIT_MS = 20_000;

let failed = false;
function expect(what: string, ok: boolean) {
  console.log(`${ok ? "ok" : "FAIL"}: ${what}`);
  if (!ok) failed = true;
}

async function shows(page: Page, selector: string): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: WAIT_MS });
    return true;
  } catch {
    return false;
  }
}

async function triageShows(page: Page, where: string, inPage = true) {
  if (inPage) expect(`${where}: no reload`, await sameDocument(page));
  expect(`${where}: triage asked for this pull request`, await asked(page));
  expect(`${where}: the chip`, await shows(page, "corbits-triage-chip .chip"));
  expect(`${where}: the sidebar block`, await shows(page, "corbits-triage-sidebar .tb"));
}

/** The page's pull request has a run, which only the content script starts on a page load or navigation. */
async function asked(page: Page): Promise<boolean> {
  const [, owner, name, , number] = new URL(page.url()).pathname.split("/");
  const key = `${owner}/${name}#${number}`;
  const end = Date.now() + WAIT_MS;
  while (Date.now() < end) {
    const states = (await worker.evaluate(() => chrome.storage.local.get("run-states")))["run-states"];
    if (states?.[key]) return true;
    await Bun.sleep(250);
  }
  return false;
}

async function gone(page: Page): Promise<boolean> {
  try {
    await page.waitForFunction(() => !document.querySelector("corbits-triage-chip, corbits-triage-sidebar")?.isConnected, undefined, { timeout: WAIT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Never a full load: the page's first document stays, so the content script is the one injected at the start. */
async function sameDocument(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { navigationMark?: true }).navigationMark === true);
}

async function mark(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { navigationMark: true }).navigationMark = true;
  });
}

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "triage-navigation-")), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
try {
  await worker.evaluate(() => chrome.storage.local.set({ onboarded: true }));
  const page = await context.newPage();
  await page.goto(`https://github.com/${repo}/pulls?q=is%3Apr`, { waitUntil: "domcontentloaded" });
  await mark(page);
  const links = page.locator(`a[href*="/${repo}/pull/"][data-hovercard-type="pull_request"], a[href*="/${repo}/pull/"][id^="issue_"]`);
  await links.first().waitFor();
  const [first, second] = await links.evaluateAll((all) => [...new Set(all.map((link) => new URL((link as HTMLAnchorElement).href).pathname))].slice(0, 2));
  if (!first || !second) throw new Error("the list has fewer than two pull requests");

  await links.first().click();
  await page.waitForURL(`**${first}`);
  await triageShows(page, "list to pull request");

  await page.locator(`a[href$="${first}/files"], a[href$="${first}/changes"]`).first().click();
  await page.waitForURL(/\/(files|changes)/);
  expect("Files tab: the chip", await shows(page, "corbits-triage-chip .chip"));
  await page.locator(`a[href$="${first}"]:visible`).first().click();
  await page.waitForURL(`**${first}`);
  // GitHub loads the Files tab and its way back as whole pages.
  await triageShows(page, "Files tab to Conversation", false);

  await mark(page);
  await page.evaluate((href) => {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = "next";
    document.querySelector(".markdown-body")?.append(link);
    link.click();
  }, second);
  await page.waitForURL(`**${second}`);
  await triageShows(page, "pull request to pull request");

  await mark(page);
  await page.goBack();
  await page.waitForURL(`**${first}`);
  await triageShows(page, "back to the first pull request");

  await mark(page);
  await page.locator(`a[href$="/${repo}/pulls"]:visible`).first().click();
  await page.waitForURL(`**/${repo}/pulls`);
  expect("leaving for the list: no reload", await sameDocument(page));
  expect("leaving for the list: the chip and block are gone", await gone(page));

  const tab = await context.newPage();
  await tab.goto(`https://github.com${second}`, { waitUntil: "domcontentloaded" });
  await triageShows(tab, "a new tab", false);
} finally {
  await context.close();
}
if (failed) process.exit(1);
