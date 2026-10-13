// The suggested actions on GitHub's page, signed out, on a real pull request: each of the five placements in light and
// dark, each one showing the triage in its own place on a pull request with nothing to apply too, the parts surviving
// GitHub's in-page navigation, an action refused with a sign-in message rather than faked, and auto-apply trying only
// what may run on its own. Applying for real needs a signed-in browser with write access.
// Run it on an open pull request that changes more than one file.
// Run: bun --conditions=intx-src e2e/page-actions.ts <owner/repo> <number> [owner/repo#number with nothing to apply]
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import type { CheckPack } from "@corbits/triage-contracts";
import { defaultLocalPack } from "../src/local-pack.ts";
import type { Applied, PageLayout } from "../src/storage.ts";

declare const chrome: { storage: { local: { get(key: string | null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } } };

const [repo, numberArg, quietArg] = process.argv.slice(2);
if (!repo || !numberArg) throw new Error("usage: page-actions.ts <owner/repo> <number> [owner/repo#number with nothing to apply]");
const number = Number(numberArg);
const key = `${repo}#${number}`;
const extension = resolve(import.meta.dir, "../.output/chrome-mv3");
const shots = resolve(import.meta.dir, "../.output/e2e");
const quietShots = resolve(import.meta.dir, "../.output/e2e/placements");
const owner = repo.split("/")[0]!;

// Every kind of action on a failing verdict, beside the default pack's.
const base = defaultLocalPack(repo);
// A limit of one file, so any pull request with more fails the max files changed rule and the verdict.
const pack: CheckPack = {
  ...base,
  checks: { ...base.checks, "max-files-changed": { enabled: true, maxFiles: 1 } },
  actions: {
    ...base.actions,
    fail: [
      ...base.actions.fail,
      { kind: "labels", target: { from: "list", labels: ["triage:too-large"] } },
      { kind: "assign", target: { to: "author" } },
      { kind: "request-review", target: { to: "users", users: [owner] } },
      { kind: "close", target: {} },
    ],
  },
};

// Each placement's own part, then the sidebar block, which shows on every pull request whatever the placement.
const PARTS: Record<PageLayout, string[]> = {
  sidebar: ["corbits-triage-sidebar"],
  inline: ["corbits-triage-title-actions", "corbits-triage-sidebar"],
  banner: ["corbits-triage-banner", "corbits-triage-sidebar"],
  "top-bar": ["corbits-triage-top-bar", "corbits-triage-sidebar"],
  composer: ["corbits-triage-drafts", "corbits-triage-sidebar"],
};

async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await Bun.sleep(300);
    await page.screenshot({ path: join(shots, `${name}-${scheme}.png`), fullPage });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

function visible(page: Page, part: string) {
  return page.locator(`${part} .bar, ${part} .drafts, ${part} .tb`).first();
}

await mkdir(shots, { recursive: true });
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "triage-actions-")), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(({ repo, pack }) => chrome.storage.local.set({ onboarded: true, packs: { [repo]: pack } }), { repo, pack });
  const page = await context.newPage();
  await page.goto(`https://github.com/${repo}/pull/${number}`, { waitUntil: "domcontentloaded" });
  const view = await until("the run", async function ran() {
    const { views, "run-states": states } = await worker.evaluate(() => chrome.storage.local.get(null));
    const state = (states as Record<string, { running: boolean; error?: string }> | undefined)?.[key];
    if (state?.error) throw new Error(`triage failed: ${state.error}`);
    return state?.running === false ? (views as Record<string, { dos: Array<{ kind: string }> }>)[key] : undefined;
  });
  console.log(`run: ${view.dos.map((step) => step.kind).join(", ")}`);

  for (const layout of ["sidebar", "inline", "banner", "top-bar", "composer"] as const) {
    await worker.evaluate((value) => chrome.storage.local.set({ "page-layout": value }), layout);
    if (layout === "composer") {
      // Signed out, GitHub shows no comment box, so one with the new composer's attributes stands in for it.
      await page.evaluate(() => {
        const box = document.createElement("textarea");
        box.setAttribute("aria-label", "Markdown value");
        box.style.cssText = "display:block;width:900px;height:120px;margin:24px auto;font:13px/1.5 monospace";
        document.querySelector("main")?.prepend(box);
      });
    }
    for (const part of PARTS[layout]) await visible(page, part).waitFor({ state: "visible" });
    const others = Object.values(PARTS).flat().filter((part) => !PARTS[layout].includes(part));
    const stray = (await Promise.all(others.map((part) => page.locator(part).count()))).some((count) => count > 0);
    console.log(`${layout}: shown with the sidebar block${stray ? ", but ANOTHER placement is still on the page" : ", and no other placement"}`);
    if (stray) process.exitCode = 1;
    await page.evaluate(() => window.scrollTo(0, 0));
    await shoot(page, `actions-${layout}`, layout === "inline" || layout === "sidebar");
  }

  // Every placement shows the triage in its own place on any pull request, with nothing to apply too, switched without
  // a reload; only a placement whose place is missing from the page gives way to the sidebar block.
  const quietPr = quietArg ? /^(.+)#(\d+)$/.exec(quietArg) : null;
  if (quietPr) {
    const [, quietRepo, quietNumber] = quietPr;
    const quietKey = `${quietRepo}#${quietNumber}`;
    await worker.evaluate(() => chrome.storage.local.set({ "page-layout": "sidebar" }));
    await page.goto(`https://github.com/${quietRepo}/pull/${quietNumber}`, { waitUntil: "domcontentloaded" });
    const quiet = await until("the quiet pull request's run", async function quietRun() {
      const { views, "run-states": states } = await worker.evaluate(() => chrome.storage.local.get(null));
      const state = (states as Record<string, { running: boolean; error?: string }> | undefined)?.[quietKey];
      if (state?.error) throw new Error(`triage failed: ${state.error}`);
      return state?.running === false ? (views as Record<string, { dos: unknown[]; suggested?: unknown[]; ended?: string }>)[quietKey] : undefined;
    });
    console.log(`${quietKey}: ${quiet.ended ?? "open"}, ${quiet.dos.length} dos, ${quiet.suggested?.length ?? 0} steps from checks`);
    // A merged or closed pull request reads as how it ended, with the score it had and nothing to apply.
    const ending = quiet.ended === "merged" ? "Merged" : quiet.ended === "closed" ? "Closed" : undefined;
    await page.locator("corbits-triage-sidebar .tb").waitFor({ state: "visible" });
    const chipText = (await page.locator("corbits-triage-chip .chip").innerText()).replace(/\s+/g, " ");
    console.log(`chip on ${quietKey}: "${chipText}"`);
    if (ending && !chipText.includes(ending)) process.exitCode = 1;
    const summaries: Record<PageLayout, string> = {
      sidebar: "corbits-triage-sidebar .tb-summary",
      inline: "corbits-triage-title-actions .bar-summary",
      banner: "corbits-triage-banner .bar-summary",
      "top-bar": "corbits-triage-top-bar .bar-summary",
      composer: "corbits-triage-drafts .drafts-summary",
    };
    for (const layout of ["sidebar", "inline", "banner", "top-bar", "composer"] as const) {
      await worker.evaluate((value) => chrome.storage.local.set({ "page-layout": value }), layout);
      if (layout === "composer") {
        // Signed out there is no comment box, so the composer's part waits for one; the sidebar block is there meanwhile.
        await page.locator("corbits-triage-sidebar .tb").waitFor({ state: "visible" });
        const early = await page.locator("corbits-triage-drafts").count();
        console.log(`composer without a comment box: ${early ? "its part is ON THE PAGE" : "nothing above a box that is not there"}, the sidebar block shows`);
        if (early) process.exitCode = 1;
        await page.evaluate(() => {
          const form = document.createElement("form");
          const box = document.createElement("textarea");
          box.setAttribute("aria-label", "Markdown value");
          box.style.cssText = "display:block;width:100%;height:120px;font:13px/1.5 monospace";
          const frame = document.createElement("div");
          frame.className = "stand-in";
          frame.style.cssText = "max-width:880px;padding:8px";
          form.append(box);
          frame.append(form);
          document.querySelector(".js-discussion")?.append(frame);
        });
      }
      const summary = page.locator(summaries[layout]);
      await summary.waitFor({ state: "visible" });
      const text = (await summary.innerText()).replace(/\s+/g, " ").trim();
      const others = Object.values(PARTS).flat().filter((part) => !PARTS[layout].includes(part));
      const stray = (await Promise.all(others.map((part) => page.locator(part).count()))).some((count) => count > 0);
      console.log(`${layout} on ${quietKey}: "${text.slice(0, 90)}"${stray ? ", but ANOTHER placement is on the page" : ""}`);
      if (!text || stray) process.exitCode = 1;
      const steps = await page.locator(`${PARTS[layout].join(" .bar-action, ")} .bar-action, corbits-triage-sidebar .tb-act`).count();
      if (ending && (!(layout === "inline" || text.includes(ending)) || steps > 0)) {
        console.log(`${layout}: does NOT read as ${ending} with nothing to apply`);
        process.exitCode = 1;
      }
      const block = await page.locator("corbits-triage-sidebar .tb").isVisible();
      if (!block) {
        console.log(`${layout}: the sidebar block is MISSING`);
        process.exitCode = 1;
      }
      // With the sidebar block in the same picture; the comment box sits far down the page, so that one is the whole page.
      await page.evaluate(() => window.scrollTo(0, 0));
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await Bun.sleep(300);
        await page.screenshot({ path: join(quietShots, `placement-${layout}-${scheme}.png`), fullPage: layout === "composer" });
      }
      await page.emulateMedia({ colorScheme: "light" });
    }
    await page.goto(`https://github.com/${repo}/pull/${number}`, { waitUntil: "domcontentloaded" });
    await worker.evaluate(() => chrome.storage.local.set({ "page-layout": "inline" }));
    for (const part of PARTS.inline) await visible(page, part).waitFor({ state: "visible" });
  }

  // GitHub swaps the page in place between a pull request's tabs; every part comes back on the Conversation tab.
  await worker.evaluate(() => chrome.storage.local.set({ "page-layout": "inline" }));
  await page.locator(`a[href$="/pull/${number}/commits"]`).first().click();
  await page.waitForURL(/\/commits$/);
  await page.locator("corbits-triage-chip .chip").waitFor({ state: "visible" });
  await page.goBack();
  await page.waitForURL(new RegExp(`/pull/${number}$`));
  for (const part of PARTS.inline) await visible(page, part).waitFor({ state: "visible" });
  console.log("in-page navigation to Commits and back: chip, title actions and sidebar back in place");

  // Signed out, applying is refused with a reason; nothing claims success.
  await page.locator("corbits-triage-title-actions .bar-action[data-kind='labels']", { hasText: "triage:too-large" }).click();
  const refused = await until("the refused label", async function refusedLabel() {
    const { applied } = await worker.evaluate(() => chrome.storage.local.get("applied"));
    return Object.entries((applied ?? {}) as Record<string, Applied>).find(([each, value]) => each.startsWith(key) && value.state === "failed")?.[1];
  });
  console.log(`label applied signed out: ${refused.state}, "${refused.error}"`);
  if (!refused.error?.includes("Sign in")) process.exitCode = 1;
  await page.locator("corbits-triage-title-actions").screenshot({ path: join(shots, "actions-refused.png") });

  // A close asks for a second click before it does anything.
  const close = page.locator("corbits-triage-title-actions .bar-action[data-kind='close']");
  await close.click();
  const confirming = await close.innerText();
  console.log(`close, first click: "${confirming}"`);
  if (confirming !== "Confirm: close this pull request") process.exitCode = 1;

  // Auto-apply on: only the label is tried once on open; the comment is never posted and the close is never tried.
  // Switched on away from the page, so only the page opened afterwards applies anything.
  await page.goto("about:blank");
  await worker.evaluate((repo) => chrome.storage.local.set({ applied: {}, "auto-apply": { [repo]: true } }), repo);
  await page.goto(`https://github.com/${repo}/pull/${number}`, { waitUntil: "domcontentloaded" });
  const tried = await until("auto-apply to finish", async function settled() {
    const { applied } = await worker.evaluate(() => chrome.storage.local.get("applied"));
    const entries = Object.entries((applied ?? {}) as Record<string, Applied>);
    return entries.length > 0 && entries.every(([, value]) => value.state !== "applying") ? entries : undefined;
  });
  console.log(`auto-apply on open, signed out: ${tried.length} tried: ${tried.map(([, value]) => `${value.state} (${value.error})`).join(", ")}`);
  if (tried.length !== 1) process.exitCode = 1;
} finally {
  await context.close();
}
