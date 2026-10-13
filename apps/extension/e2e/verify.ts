// End-to-end check of the Chrome build on real pull requests: the toolbar button opening the side panel, the welcome
// tab and first-run steps, the panel's home and settings, the chip, local runs compared with the shared triage logic run
// here on the same pull request, a revisit on an unchanged head reusing its run, and a failed refresh shown against the
// last successful run. Then, on a second pull request, of the same or another repository, with failing checks: the chip's hover
// card, the page's drafts menu and the panel's drafts filling the comment box, and the check manager re-scoring from
// the saved GitHub reads as checks are switched, limits changed, a check added and the defaults restored.
// Run it on the welcome steps' example pull request, corbitsdev/corbits-triage's newest open one (158 when none is
// open), and an open one that fails a check. The guided tour waits on the example and is skipped here.
// The token is entered in the panel's settings and used for the comparison.
// Run: bun --conditions=intx-src e2e/verify.ts <owner/repo> <number> <failing number or owner/repo#number> <github token> [runs] [owner/repo#number,…]
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Locator, type Page, type Worker } from "playwright";
import { draftsOf, withFooter } from "../src/drafts.ts";
import { bestDraft, pageActions } from "../src/page-actions.ts";
import { defaultLocalPack } from "../src/local-pack.ts";
import { prFromUrl, prKey, type PrRef } from "../src/pr.ts";
import { runLocal } from "../src/local-run.ts";
import type { TriageView } from "../src/view.ts";

// The service worker's extension API, as the evaluated functions below use it.
declare const chrome: {
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  sidePanel: { getPanelBehavior(): Promise<{ openPanelOnActionClick?: boolean }> };
};

const [repo, numberArg, failingArg, token, runsArg = "3", parityArg = ""] = process.argv.slice(2);
if (!repo || !numberArg || !failingArg || !token) throw new Error("usage: verify.ts <owner/repo> <number> <failing number or owner/repo#number> <github token> [runs] [owner/repo#number,…]");
// More pull requests whose runs are only compared with the shared logic, for what the two above do not cover, such as
// legacy commit statuses beside check runs, or a workflow job run again under another event.
const parityPrs = parityArg.split(",").filter(Boolean).map(function parse(ref): PrRef {
  const match = /^(.+)#(\d+)$/.exec(ref);
  if (!match) throw new Error(`not a pull request: ${ref}`);
  return { repo: match[1]!, number: Number(match[2]) };
});
const pr = { repo, number: Number(numberArg) };
// The example's repository may have no second open pull request, so the failing one can be in another repository.
const failingRef = /^(.+)#(\d+)$/.exec(failingArg);
const failingPr = failingRef ? { repo: failingRef[1]!, number: Number(failingRef[2]) } : { repo, number: Number(failingArg) };
const runs = Number(runsArg);
const extension = resolve(import.meta.dir, "../.output/chrome-mv3");
const shots = resolve(import.meta.dir, "../.output/e2e");
// The side panel's narrow default and a widened one; Chrome lets a person drag it between about 320 and 600 pixels.
const PANEL_WIDTHS = [360, 480];
const PANEL_MIN = 320;
const PANEL_MAX = 600;
const DEBUG_PORT = 9333;

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl: string };

/** One CDP connection to a target Playwright does not expose, such as the side panel. */
async function cdp(target: Target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  let next = 0;
  const waiting = new Map<number, (result: any) => void>();
  socket.onmessage = function onMessage(event) {
    const message = JSON.parse(String(event.data));
    waiting.get(message.id)?.(message);
  };
  async function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++next;
    const reply = await new Promise<any>((done) => {
      waiting.set(id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  }
  /** `userGesture` makes the call count as a click, which opening the side panel needs. */
  async function evaluate<T>(expression: string, userGesture = false): Promise<T> {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
    return result.result.value as T;
  }
  return { send, evaluate, close: () => socket.close() };
}

async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Cdp = Awaited<ReturnType<typeof cdp>>;

async function targets(): Promise<Target[]> {
  return (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as Target[];
}

/** Light and dark, as the Corbits theme follows the system's scheme. */
async function shootPage(page: Page, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await Bun.sleep(200);
    await page.screenshot({ path: join(shots, `${name}-${scheme}.png`), fullPage: true });
  }
}

/** A part of GitHub's page, in GitHub's light and dark themes, which follow the system's scheme when signed out. */
async function shootPart(page: Page, part: Locator, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await Bun.sleep(200);
    await part.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** The whole panel at each width, its viewport as tall as its content so the sticky footer sits at the end; at
 * Chrome's narrowest and widest panel too, where nothing may scroll sideways. */
async function shootPanel(panel: Cdp, name: string): Promise<void> {
  for (const width of [PANEL_MIN, ...PANEL_WIDTHS, PANEL_MAX]) {
    await panel.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await Bun.sleep(100);
    const [height, scrollWidth] = await panel.evaluate<[number, number]>("[document.documentElement.scrollHeight, document.documentElement.scrollWidth]");
    if (scrollWidth > width) {
      console.log(`${name} at ${width}px: SCROLLS SIDEWAYS (${scrollWidth}px wide)`);
      process.exitCode = 1;
    }
    if (!PANEL_WIDTHS.includes(width)) continue;
    await panel.send("Emulation.setDeviceMetricsOverride", { width, height: Math.max(900, height), deviceScaleFactor: 1, mobile: false });
    for (const scheme of ["light", "dark"] as const) {
      await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await Bun.sleep(300);
      const shot = await panel.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await Bun.write(join(shots, `${name}-${width}-${scheme}.png`), Buffer.from(shot.data, "base64"));
    }
  }
  await panel.send("Emulation.clearDeviceMetricsOverride");
}

async function panelShows(panel: Cdp, what: string, selector: string): Promise<void> {
  await until(what, async function shown() {
    return (await panel.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) || undefined;
  });
}

async function clickInPanel(panel: Cdp, name: string): Promise<void> {
  const clicked = await panel.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(name)} || b.getAttribute("aria-label") === ${JSON.stringify(name)});
    button?.click();
    return Boolean(button);
  })()`);
  if (!clicked) throw new Error(`the panel has no "${name}" button`);
}

async function storedView(worker: Worker, of: PrRef = pr): Promise<TriageView | undefined> {
  return worker.evaluate(async (key) => {
    const { views } = await chrome.storage.local.get("views");
    return (views as Record<string, TriageView> | undefined)?.[key];
  }, prKey(of));
}

async function runState(worker: Worker, of: PrRef = pr): Promise<{ running: boolean; error?: string } | undefined> {
  return worker.evaluate(async (key) => {
    const { "run-states": states } = await chrome.storage.local.get("run-states");
    return (states as Record<string, { running: boolean; error?: string }> | undefined)?.[key];
  }, prKey(of));
}

/** The next finished run of a pull request after `before`, failing on a recorded error. */
async function nextRun(worker: Worker, of: PrRef, what: string, before: string | undefined): Promise<TriageView> {
  return until(what, async function finished() {
    const state = await runState(worker, of);
    if (state?.error) throw new Error(`triage failed: ${state.error}`);
    const view = await storedView(worker, of);
    return state?.running === false && view && view.ranAt !== before ? view : undefined;
  });
}

async function clickSwitch(panel: Cdp, name: string): Promise<void> {
  const clicked = await panel.evaluate<boolean>(`(() => {
    const control = document.querySelector('[role="switch"][aria-label=${JSON.stringify(name)}]');
    control?.click();
    return Boolean(control);
  })()`);
  if (!clicked) throw new Error(`the panel has no "${name}" switch`);
}

/** Types into a panel field the way React hears it, by its label's text. */
async function fillInPanel(panel: Cdp, label: string, value: string): Promise<void> {
  const filled = await panel.evaluate<boolean>(`(() => {
    const field = [...document.querySelectorAll("label")].find((each) => each.textContent === ${JSON.stringify(label)});
    const input = field && document.getElementById(field.htmlFor);
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  if (!filled) throw new Error(`the panel has no "${label}" field`);
}

async function runStateAt(worker: Worker): Promise<string | undefined> {
  return worker.evaluate(async (key) => {
    const { "run-states": states } = await chrome.storage.local.get("run-states");
    return (states as Record<string, { at: string }> | undefined)?.[key]?.at;
  }, prKey(pr));
}

function authedGithub(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`https://api.github.com${path}`, { ...init, headers });
}

/** What must match: everything the panel shows except when it ran and GitHub's rate counter. */
function comparable(view: TriageView) {
  return {
    headSha: view.headSha,
    readiness: view.readiness,
    state: view.verdict.state,
    nextAction: view.verdict.nextAction,
    feedback: view.verdict.feedback,
    merge: view.verdict.merge,
    checks: view.checks.map(({ check, result, reason, evidence }) => ({ check, result, reason, evidence })),
    dos: view.dos.map((step) => step.effectId),
    waitingOnJudge: view.waitingOnJudge,
  };
}

await mkdir(shots, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "triage-e2e-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--remote-debugging-port=${DEBUG_PORT}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const behavior = await worker.evaluate(() => chrome.sidePanel.getPanelBehavior());
  console.log(`toolbar button opens the panel: ${behavior.openPanelOnActionClick === true}`);
  if (behavior.openPanelOnActionClick !== true) process.exitCode = 1;

  const welcome = await until("the welcome tab", async function welcomeTab() {
    return context.pages().find((each) => each.url().endsWith("/welcome.html"));
  });
  await welcome.getByRole("button", { name: "Get started" }).waitFor();
  await shootPage(welcome, "welcome-1-intro");
  console.log("welcome tab opened on install");

  // The welcome tab is not a pull request, so the panel opened beside it shows the first-run steps.
  const welcomeTarget = (await targets()).find((target) => target.url.endsWith("/welcome.html"))!;
  const welcomeCdp = await cdp(welcomeTarget);
  await welcomeCdp.evaluate("chrome.tabs.getCurrent().then((tab) => chrome.sidePanel.open({ tabId: tab.id }))", true);
  welcomeCdp.close();
  const panel = await cdp(await until("the side panel", async function findPanel() {
    return (await targets()).find((target) => target.url.endsWith("/sidepanel.html"));
  }));
  await panelShows(panel, "the panel's first-run steps", ".onboarding");
  await shootPanel(panel, "panel-onboarding-1-intro");

  await welcome.getByRole("button", { name: "Get started" }).click();
  await welcome.getByRole("heading", { name: "Pin Triage to your toolbar" }).waitFor();
  await shootPage(welcome, "welcome-2-pin");
  await welcome.getByRole("button", { name: "Continue" }).click();
  await welcome.getByRole("heading", { name: "Add a decision model" }).waitFor();
  await shootPage(welcome, "welcome-3-model");
  await welcome.getByRole("button", { name: "Skip for now" }).click();
  await welcome.getByRole("heading", { name: "Add a GitHub token" }).waitFor();
  await shootPage(welcome, "welcome-4-token");
  console.log("welcome steps: intro, pin, decision model, GitHub token");

  await clickInPanel(panel, "Get started");
  await panelShows(panel, "the panel's pin step", ".pin-steps");
  await shootPanel(panel, "panel-onboarding-2-pin");
  await clickInPanel(panel, "Done");
  await panelShows(panel, "the panel's home view", ".home");
  await shootPanel(panel, "panel-home-empty");
  console.log("panel: first-run steps finished, home view on a tab that is not a pull request");

  await clickInPanel(panel, "Settings");
  await panelShows(panel, "the token form", "form.github-token");
  await fillInPanel(panel, "GitHub token", token);
  await clickInPanel(panel, "Save token");
  await panelShows(panel, "the saved token", ".saved-setting.github-token");
  await clickInPanel(panel, "Back");
  await panelShows(panel, "the home view again", ".home");
  console.log("GitHub token saved from the panel's settings");

  await welcome.getByRole("heading", { name: "You're set" }).waitFor();
  await shootPage(welcome, "welcome-5-done");
  const [page] = await Promise.all([context.waitForEvent("page"), welcome.getByRole("button", { name: "Open an example pull request" }).click()]);
  await page.waitForLoadState("domcontentloaded");
  console.log(`welcome opened ${page.url()}`);
  const opened = prFromUrl(page.url());
  if (!opened || prKey(opened) !== prKey(pr)) throw new Error(`the welcome page opened ${page.url()}, not ${prKey(pr)}`);

  // The tour starts on the example; Escape skips it.
  await page.locator(".driver-popover.corbits-tour").waitFor({ state: "visible", timeout: 90_000 });
  await page.keyboard.press("Escape");
  await page.locator(".driver-popover").waitFor({ state: "detached" });
  console.log("guided tour started on the example and was skipped with Escape");
  const chip = page.locator("corbits-triage-chip .chip");
  await chip.waitFor({ state: "visible" });
  const first = await until("the first local run", async function firstRun() {
    const state = await runState(worker);
    if (state?.error) throw new Error(`triage failed: ${state.error}`);
    return state?.running === false ? storedView(worker) : undefined;
  });
  await page.waitForFunction(() => document.querySelector("corbits-triage-chip")?.shadowRoot?.querySelector(".score")?.textContent !== "…");
  await shootPart(page, page.locator("corbits-triage-chip").locator(".."), "chip");
  console.log(`chip: ${await chip.innerText()}`);

  await chip.click();
  await panelShows(panel, "the panel to render the run", ".score-card");
  await shootPanel(panel, "panel-triage");
  console.log("panel follows the active tab to the pull request's triage view");

  // Each run is compared with the shared logic as soon as it is made, so a pull request whose CI is still running is
  // read by both at nearly the same moment.
  const results: Array<{ view: TriageView; shared: TriageView }> = [];
  async function compared(view: TriageView): Promise<TriageView> {
    results.push({ view, shared: await runLocal(view.pr, { gh: authedGithub, pack: defaultLocalPack(view.pr.repo) }) });
    return view;
  }
  await compared(first);
  for (let run = 1; run < runs; run++) {
    const before = results.at(-1)!.view.ranAt;
    await panel.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Run again").click()`);
    await compared(await until(`local run ${run + 1}`, async function rerun() {
      const state = await runState(worker);
      if (state?.error) throw new Error(`triage failed: ${state.error}`);
      const view = await storedView(worker);
      return state?.running === false && view && view.ranAt !== before ? view : undefined;
    }));
  }

  // Back an hour, the run is past its fresh window, so a reload asks GitHub for the head and keeps the run when it is unchanged.
  const kept = results.at(-1)!.view;
  const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  await worker.evaluate(async ({ key, ranAt }) => {
    const { views } = await chrome.storage.local.get("views");
    const all = views as Record<string, TriageView>;
    await chrome.storage.local.set({ views: { ...all, [key]: { ...all[key]!, ranAt } } });
  }, { key: prKey(pr), ranAt: anHourAgo });
  const checkedBefore = (await runStateAt(worker)) ?? "";
  await page.reload({ waitUntil: "domcontentloaded" });
  await until("the head check on reload", async function headChecked() {
    const state = await runState(worker);
    const at = await runStateAt(worker);
    return state?.running === false && at !== undefined && at > checkedBefore ? true : undefined;
  });
  const revisited = await storedView(worker);
  console.log(`revisit on head ${kept.headSha.slice(0, 7)}: ${revisited?.ranAt === anHourAgo ? "kept the run, no rescore" : "SCORED AGAIN"}`);
  if (revisited?.ranAt !== anHourAgo) process.exitCode = 1;

  // GitHub's limit cannot be spent on purpose here, so the failed refresh it causes is written as the worker writes it.
  await worker.evaluate(async ({ key }) => {
    const { "run-states": states } = await chrome.storage.local.get("run-states");
    const resetAt = new Date(Date.now() + 1_800_000).toISOString();
    const error = "GitHub's hourly limit for requests without a token is used up.";
    await chrome.storage.local.set({ "github-token": null, "run-states": { ...(states as object), [key]: { running: false, error, resetAt, head: "0123456789abcdef", at: new Date().toISOString() } } });
  }, { key: prKey(pr) });
  await panelShows(panel, "the failed refresh over the last run", 'form.github-token');
  await shootPanel(panel, "panel-limit");
  const staleChip = await chip.innerText();
  await shootPart(page, page.locator("corbits-triage-chip").locator(".."), "chip-stale");
  console.log(`failed refresh: chip "${staleChip.replace(/\n/g, " ")}", panel offers a token`);
  if (!staleChip.includes("Stale") || !staleChip.includes("new commits")) process.exitCode = 1;
  await worker.evaluate(async ({ key, value }) => {
    const { "run-states": states } = await chrome.storage.local.get("run-states");
    const { [key]: _, ...rest } = states as Record<string, unknown>;
    await chrome.storage.local.set({ "github-token": value, "run-states": rest });
  }, { key: prKey(pr), value: token });

  await clickInPanel(panel, "Settings");
  await panelShows(panel, "the settings view", ".settings");
  await shootPanel(panel, "panel-settings");
  await clickInPanel(panel, "Back");
  await panelShows(panel, "the triage view again", ".score-card");
  console.log("settings open from the panel's header and close back to the triage view");

  await welcome.bringToFront();
  await panelShows(panel, "the home view with recent pull requests", ".recents");
  await shootPanel(panel, "panel-home");
  console.log("home view lists the pull request just scored");

  // A pull request with failing checks: the chip's hover card, the drafts menu by the comment box and the panel's actions.
  await worker.evaluate(() => chrome.storage.local.set({ "page-layout": "composer" }));
  await page.bringToFront();
  await page.goto(`https://github.com/${failingPr.repo}/pull/${failingPr.number}`, { waitUntil: "domcontentloaded" });
  const failing = await nextRun(worker, failingPr, "the failing pull request's run", undefined);
  await compared(failing);
  await page.waitForFunction((n) => document.querySelector("corbits-triage-chip")?.shadowRoot?.querySelector(".chip")?.getAttribute("aria-label")?.includes(`#${n}: score`), failingPr.number);
  await shootPart(page, page.locator("corbits-triage-chip").locator(".."), "chip-failing");
  await chip.hover();
  const card = page.locator("corbits-triage-chip .card");
  await card.waitFor({ state: "visible" });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await Bun.sleep(200);
    const [chipBox, cardBox] = [await chip.boundingBox(), await card.boundingBox()];
    const left = Math.min(chipBox!.x, cardBox!.x) - 16;
    const top = chipBox!.y - 16;
    await page.screenshot({ path: join(shots, `chip-card-${scheme}.png`), clip: { x: left, y: top, width: Math.max(chipBox!.x + chipBox!.width, cardBox!.x + cardBox!.width) - left + 16, height: cardBox!.y + cardBox!.height - top + 16 } });
  }
  await page.emulateMedia({ colorScheme: "light" });
  const cardText = await card.innerText();
  const topFailing = failing.checks.find((check) => check.result === "fail" && !check.gate);
  console.log(`hover card: "${cardText.split("\n").slice(0, 3).join(" / ")}"`);
  if (!cardText.includes(failing.verdict.nextAction) || (topFailing && !cardText.includes(topFailing.name))) process.exitCode = 1;
  await page.mouse.move(0, 0);
  await card.waitFor({ state: "hidden" });
  await chip.focus();
  await card.waitFor({ state: "visible" });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "hidden" });
  await Bun.sleep(500);
  const reopened = await card.isVisible();
  const chipFocused = await page.evaluate(() => document.querySelector("corbits-triage-chip")?.shadowRoot?.activeElement?.classList.contains("chip") === true);
  console.log(`hover card opens on hover and on focus; Escape from its actions closes it ${reopened ? "but it REOPENS" : "and it stays closed"}, focus ${chipFocused ? "back on the chip" : "LOST"}`);
  if (reopened || !chipFocused) process.exitCode = 1;

  // Signed out, GitHub shows no comment box, so a box with the new composer's attributes stands in for it, and the
  // sidebar's label picker, which tells Triage the person can triage the pull request, gets a stand-in too.
  await page.evaluate(() => {
    const picker = document.createElement("form");
    picker.setAttribute("aria-label", "Select labels");
    document.querySelector("#partial-discussion-sidebar")?.append(picker);
    const box = document.createElement("textarea");
    box.setAttribute("aria-label", "Markdown value");
    box.placeholder = "Use Markdown to format your comment";
    box.style.cssText = "display:block;width:900px;height:160px;margin:24px auto;font:13px/1.5 monospace";
    box.addEventListener("input", () => (box.dataset.inputEvents = String(Number(box.dataset.inputEvents ?? 0) + 1)));
    document.querySelector("main")?.prepend(box);
  });
  const box = page.locator('textarea[aria-label="Markdown value"]');
  const drafts = draftsOf(failing);
  if (!drafts.length) throw new Error(`${prKey(failingPr)} suggests no drafts; pass a pull request that fails a check with a comment`);
  // The best draft is put in the empty box on its own, without taking focus or posting.
  await page.waitForFunction((body) => (document.querySelector('textarea[aria-label="Markdown value"]') as HTMLTextAreaElement).value === body, withFooter(bestDraft(pageActions(failing))!.body!, true));
  const seededFocus = await page.evaluate(() => document.activeElement?.tagName);
  console.log(`comment box seeded with the best draft, focus ${seededFocus === "TEXTAREA" ? "TAKEN" : "left where it was"}`);
  if (seededFocus === "TEXTAREA") process.exitCode = 1;
  await box.fill("");
  await page.locator("corbits-triage-drafts .drafts-toggle").click();
  await page.locator("corbits-triage-drafts .drafts-panel").waitFor({ state: "visible" });
  await shootPart(page, page.locator("corbits-triage-drafts").locator(".."), "drafts-menu");
  await page.locator("corbits-triage-drafts .draft-edit").first().click();
  const fromMenu = await box.inputValue();
  const firstText = withFooter(drafts[0]!.body, true);
  await box.screenshot({ path: join(shots, "draft-from-menu.png") });
  console.log(`draft from the page's menu: ${fromMenu === firstText ? "matches" : "DIFFERS"}, input events: ${await box.getAttribute("data-input-events")}`);
  if (fromMenu !== firstText) process.exitCode = 1;
  const everything = drafts.find((each) => each.id === "feedback");
  // Every failing check together is the menu's last draft, beside the others.
  if (everything && drafts.length > 1) {
    await page.locator("corbits-triage-drafts .drafts-toggle").click();
    await page.locator("corbits-triage-drafts .draft-edit").last().click();
    const appended = await box.inputValue();
    const both = `${firstText}\n\n${withFooter(everything.body, true)}`;
    console.log(`every failing check appended: ${appended === both ? "matches" : "DIFFERS"}`);
    if (appended !== both) process.exitCode = 1;
  }

  await box.fill("");
  await panelShows(panel, "the failing pull request in the panel", ".actions-list");
  await shootPanel(panel, "panel-triage-failing");
  const fromPanel = await panel.evaluate<string>(`(() => {
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "Edit first");
    button.click();
    return button.closest("li").querySelector("blockquote").textContent;
  })()`);
  await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Markdown value"]') as HTMLTextAreaElement).value.length > 0);
  const value = await box.inputValue();
  await box.screenshot({ path: join(shots, "draft-from-panel.png") });
  console.log(`draft from the panel: ${value === withFooter(fromPanel, true) ? "matches" : "DIFFERS"}`);
  if (value !== withFooter(fromPanel, true)) process.exitCode = 1;

  // The check manager: each change re-scores the saved reads, so GitHub's remaining calls stay where they were.
  await clickInPanel(panel, "Settings");
  await panelShows(panel, "the settings view", ".repo-link");
  await panel.evaluate(`document.querySelector(".repo-link").click()`);
  await panelShows(panel, "the check manager", ".manager");
  // Without a decision model its checks are listed but switched off, with the way to add one.
  const modelChecks = await panel.evaluate<{ locked: boolean; link: boolean }>(`(() => {
    const rows = [...document.querySelectorAll(".manage-row")].filter((row) => row.querySelector(".eval")?.textContent === "Decision model");
    const switches = rows.flatMap((row) => [...row.querySelectorAll('[role="switch"]')]);
    return {
      locked: switches.length > 0 && switches.every((each) => each.disabled || each.getAttribute("aria-disabled") === "true"),
      link: [...document.querySelectorAll(".manager button")].some((each) => each.textContent === "Add a decision model"),
    };
  })()`);
  console.log(`model checks without a decision model: ${modelChecks.locked ? "switched off" : "SWITCHABLE"}, ${modelChecks.link ? "with" : "WITHOUT"} the way to add one`);
  if (!modelChecks.locked || !modelChecks.link) process.exitCode = 1;
  await shootPanel(panel, "panel-checks");
  const calls = failing.rate?.remaining;
  async function rescored(what: string, before: TriageView): Promise<TriageView> {
    const view = await nextRun(worker, failingPr, what, before.ranAt);
    const fetched = view.rate?.remaining !== calls;
    console.log(`${what}: readiness ${before.readiness} -> ${view.readiness}, ${fetched ? "READ GITHUB AGAIN" : "no GitHub calls"}`);
    if (fetched) process.exitCode = 1;
    return view;
  }
  await clickSwitch(panel, "Max files changed");
  let managed = await rescored("max files changed switched off", failing);
  if (managed.checks.some((check) => check.check === "max-files-changed")) process.exitCode = 1;
  await clickSwitch(panel, "Max files changed");
  managed = await rescored("max files changed switched on", managed);
  await clickInPanel(panel, "Edit the limits");
  await fillInPanel(panel, "Most files", "1000");
  await shootPanel(panel, "panel-checks-edit");
  await clickInPanel(panel, "Save limits");
  managed = await rescored("files limit raised", managed);
  if (managed.checks.find((check) => check.check === "max-files-changed")?.result !== "pass") process.exitCode = 1;
  await clickInPanel(panel, "Add a rule");
  await clickInPanel(panel, "Use Title matches a pattern");
  await fillInPanel(panel, "Title must match", "^(feat|fix|refactor|chore|docs|test)\\(");
  await shootPanel(panel, "panel-checks-add");
  await clickInPanel(panel, "Add rule");
  managed = await rescored("title rule added", managed);
  const titleRule = managed.checks.find((check) => check.name === "Title matches a pattern");
  console.log(`added rule check: ${titleRule ? `${titleRule.result}, ${titleRule.reason}` : "MISSING"}`);
  if (!titleRule) process.exitCode = 1;
  await panelShows(panel, "the changed scope", '.scope[data-changed="true"]');
  await shootPanel(panel, "panel-checks-changed");
  await clickInPanel(panel, "Reset to defaults");
  await clickInPanel(panel, "Confirm: reset every rule");
  managed = await rescored("defaults restored", managed);
  const restored = Bun.deepEquals(comparable(managed), comparable(failing), true);
  console.log(`defaults restored: ${restored ? "same verdict as the first run" : "DIFFERS from the first run"}`);
  if (!restored) process.exitCode = 1;
  await clickInPanel(panel, "Back");
  await panelShows(panel, "the settings view again", ".settings");
  await clickInPanel(panel, "Back");
  await panelShows(panel, "the triage view again", ".score-card");
  panel.close();

  for (const parity of parityPrs) {
    await page.goto(`https://github.com/${parity.repo}/pull/${parity.number}`, { waitUntil: "domcontentloaded" });
    await compared(await nextRun(worker, parity, `${prKey(parity)}'s run`, undefined));
  }

  for (const [index, { view, shared }] of results.entries()) {
    // Extension storage does not keep key order, so the comparison is structural.
    const same = Bun.deepEquals(comparable(view), comparable(shared), true);
    console.log(`run ${index + 1}, #${view.pr.number}: readiness ${view.readiness}, ${view.verdict.state}, ${view.checks.length} checks, ${view.dos.length} dos, read through ${view.reads?.session} github.com requests and ${view.reads?.api} API calls: ${same ? "matches the shared logic" : "DIFFERS from the shared logic"}`);
    if (!same) {
      console.log(JSON.stringify({ extension: comparable(view), shared: comparable(shared) }, null, 2));
      process.exitCode = 1;
    }
  }
} finally {
  await context.close();
}
