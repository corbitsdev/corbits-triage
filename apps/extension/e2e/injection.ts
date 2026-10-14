// Triage on GitHub's page, signed out, on a real pull request under a stricter pack, so most kinds of step show: the
// sidebar block in light and dark; the best draft put in an empty comment box once, without taking focus, for someone
// who can triage, taken back out with Undo and not put in again after a reload; "Link an issue" adding the reference
// to the description's editor only when clicked, with Undo until the person finishes it; a sidebar picker pre-checked
// once with what Triage suggests; edits refused with a sign-in message;
// markers on the Files tab that survive in-page navigation; the guided tour from start to the side panel; and the
// full-tab workspace at two widths. Signed out, GitHub renders no comment box, editors or pickers, so stand-ins with
// the markup Triage looks for take their place; applying for real needs a signed-in browser with write access.
// Run: bun --conditions=intx-src e2e/injection.ts <owner/repo> <number> <github token>
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Locator, type Page, type Worker } from "playwright";
import { parseCheckPack } from "@corbits/triage-contracts";
import { defaultLocalPack } from "../src/local-pack.ts";
import type { Applied } from "../src/storage.ts";
import type { TriageView } from "../src/view.ts";

declare const chrome: { storage: { local: { get(key: string | null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } } };

const [repo, numberArg, token] = process.argv.slice(2);
if (!repo || !numberArg || !token) throw new Error("usage: injection.ts <owner/repo> <number> <github token>");
const number = Number(numberArg);
const key = `${repo}#${number}`;
const extension = resolve(import.meta.dir, "../.output/chrome-mv3");
const shots = resolve(import.meta.dir, "../.output/e2e");
const DEBUG_PORT = 9334;
const LABEL = "needs-triage-review";

// Stricter than the default: a GitHub issue reference, small size limits, every path forbidden, and a label on Fail.
const base = defaultLocalPack(repo);
const pack = parseCheckPack({
  ...base,
  checks: { ...base.checks, "linked-issue": { enabled: true, tracker: "github" }, "max-files-changed": { enabled: true, maxFiles: 5 }, "max-lines-changed": { enabled: true, maxLines: 200 }, "no-forbidden-paths": { enabled: true, forbiddenGlobs: ["**"] } },
  actions: { ...base.actions, fail: [{ do: "labels", target: { from: "list", labels: [LABEL] } }] },
}, repo);
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
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function shoot(page: Page, part: Locator | null, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await Bun.sleep(300);
    if (part) await part.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
    else await page.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

async function stored(worker: Worker): Promise<Record<string, any>> {
  return worker.evaluate(() => chrome.storage.local.get(null));
}

async function finishedRun(worker: Worker): Promise<TriageView> {
  return until("the run", async function ran() {
    const all = await stored(worker);
    const state = all["run-states"]?.[key];
    if (state?.error) throw new Error(`triage failed: ${state.error}`);
    return state?.running === false ? (all.views?.[key] as TriageView | undefined) : undefined;
  });
}

/** GitHub's sidebar label picker, closed, as someone who can triage the pull request sees it. */
async function standInPicker(page: Page): Promise<void> {
  await page.evaluate((label) => {
    const form = document.createElement("form");
    form.setAttribute("aria-label", "Select labels");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Labels";
    const menu = document.createElement("details-menu");
    for (const name of ["bug", label]) {
      const row = document.createElement("label");
      row.setAttribute("role", "menuitemcheckbox");
      row.style.display = "flex";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.name = "issue[labels][]";
      box.value = name;
      row.append(box, name);
      menu.append(row);
    }
    details.append(summary, menu);
    form.append(details);
    document.querySelector("#partial-discussion-sidebar")?.append(form);
  }, LABEL);
}

/** Signed out, GitHub renders no comment box; one with the new composer's attributes stands in for it. */
async function standInComposer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const form = document.createElement("form");
    const box = document.createElement("textarea");
    box.setAttribute("aria-label", "Markdown value");
    box.style.cssText = "display:block;width:100%;height:120px;font:13px/1.5 monospace";
    const frame = document.createElement("div");
    frame.className = "stand-in";
    frame.style.cssText = "max-width:880px;margin:24px 0;padding:8px";
    form.append(box);
    frame.append(form);
    document.querySelector(".js-discussion")?.append(frame);
  });
}

await mkdir(shots, { recursive: true });
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "triage-injection-")), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--remote-debugging-port=${DEBUG_PORT}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(({ repo, pack, token }) => chrome.storage.local.set({ onboarded: true, packs: { [repo]: pack }, "github-token": token }), { repo, pack, token });
  const page = await context.newPage();
  await page.goto(`https://github.com/${repo}/pull/${number}`, { waitUntil: "domcontentloaded" });
  const view = await finishedRun(worker);
  const kinds = (view.suggested ?? []).map((action) => action.kind);
  console.log(`run: readiness ${view.readiness}, ${view.verdict.state}; steps from checks: ${kinds.join(", ")}; ${view.notes?.length ?? 0} file notes`);
  expect("a missing issue reference suggests editing the description", kinds.includes("edit-body"));
  expect("the fail list's label is suggested", view.dos.some((action) => action.kind === "labels" && "labels" in action.target && action.target.labels.includes(LABEL)));
  expect("the forbidden paths become file notes", (view.notes ?? []).length > 0);

  // The sidebar block, the default placement.
  const block = page.locator("corbits-triage-sidebar .tb");
  await block.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("corbits-triage-sidebar")?.shadowRoot?.querySelectorAll(".tb-act").length);
  const steps = await page.locator("corbits-triage-sidebar .tb-act").count();
  expect("the sidebar block lists the suggested steps", steps >= 4, `${steps} steps`);
  const blockText = await page.locator("corbits-triage-sidebar .tb").innerText();
  expect("without a decision model, no model check shows in the block", !/decision model/i.test(blockText));
  await shoot(page, page.locator("corbits-triage-sidebar"), "block");
  await shoot(page, null, "page-sidebar");

  // Someone who can triage the pull request sees GitHub's label picker; signed out there is none, so a stand-in with
  // its markup takes its place, closed.
  await standInPicker(page);
  // The best draft goes into an empty comment box once, without taking focus; Undo takes it out again.
  await standInComposer(page);
  const box = page.locator('textarea[aria-label="Markdown value"]');
  await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Markdown value"]') as HTMLTextAreaElement).value.length > 0);
  const focus = await page.evaluate(() => document.activeElement?.tagName);
  expect("the comment box is seeded without taking focus", focus !== "TEXTAREA", `focus on ${focus}`);
  const note = page.locator("corbits-triage-composer-seed .seed-note");
  await note.waitFor({ state: "visible" });
  await box.scrollIntoViewIfNeeded();
  await shoot(page, page.locator(".stand-in:has(textarea[aria-label='Markdown value'])"), "seeded-comment");
  const blockSaysSeeded = await page.locator("corbits-triage-sidebar .tb-seeded").count();
  expect("the block marks the draft as in the comment box", blockSaysSeeded === 1);
  await note.locator(".seed-undo").click();
  await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Markdown value"]') as HTMLTextAreaElement).value === "");
  await note.waitFor({ state: "detached" });
  expect("Undo empties the comment box and the note goes", true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await block.waitFor({ state: "visible" });
  await standInPicker(page);
  await standInComposer(page);
  await Bun.sleep(1500);
  expect("the draft is not put in again after a reload", (await box.inputValue()) === "");

  // "Link an issue" opens the description's editor and adds the reference at its end; Undo takes it back out.
  await page.evaluate(() => {
    const frame = document.createElement("div");
    frame.className = "stand-in";
    frame.style.cssText = "max-width:880px;margin:24px 0;padding:8px";
    const form = document.createElement("form");
    const field = document.createElement("textarea");
    field.name = "pull_request[body]";
    field.value = "Existing description.";
    field.style.cssText = "display:block;width:100%;height:100px";
    form.append(field);
    frame.append(form);
    document.querySelector(".js-discussion")?.prepend(frame);
  });
  const body = page.locator('textarea[name="pull_request[body]"]');
  await Bun.sleep(1000);
  expect("opening the description's editor adds nothing on its own", (await body.inputValue()) === "Existing description.");
  await page.locator("corbits-triage-sidebar .tb-act[data-kind='edit-body']").click();
  await page.waitForFunction(() => (document.querySelector('textarea[name="pull_request[body]"]') as HTMLTextAreaElement).value.includes("Closes #"));
  expect("Link an issue appends the reference to the open editor", (await body.inputValue()) === "Existing description.\n\nCloses #");
  await page.locator("corbits-triage-body-seed .seed-note").waitFor({ state: "visible" });
  await shoot(page, page.locator(".stand-in:has(textarea[name='pull_request[body]'])"), "seeded-description");
  await page.locator("corbits-triage-body-seed .seed-undo").click();
  await page.waitForFunction(() => (document.querySelector('textarea[name="pull_request[body]"]') as HTMLTextAreaElement).value === "Existing description.");
  expect("Undo restores the description as it was", true);
  await page.locator("corbits-triage-sidebar .tb-act[data-kind='edit-body']").click();
  await page.waitForFunction(() => (document.querySelector('textarea[name="pull_request[body]"]') as HTMLTextAreaElement).value.endsWith("Closes #"));
  await body.press("End");
  await body.pressSequentially("123");
  await page.locator("corbits-triage-body-seed .seed-note").waitFor({ state: "detached" });
  expect("a reference the person finished is theirs: no Undo offered", (await body.inputValue()).endsWith("Closes #123"));
  // The label picker, opened: the suggested label is checked and marked, and clicking its row unchecks it.
  await page.evaluate(() => {
    document.querySelector<HTMLDetailsElement>('form[aria-label="Select labels"] details')!.open = true;
  });
  await page.waitForFunction((label) => (document.querySelector(`form[aria-label="Select labels"] input[value="${label}"]`) as HTMLInputElement)?.checked, LABEL);
  const marked = await page.locator("form[aria-label='Select labels'] .corbits-triage-suggested").count();
  const other = await page.locator("form[aria-label='Select labels'] input[value='bug']").isChecked();
  expect("the opened label picker has the suggested label checked and marked, nothing else", marked === 1 && !other);
  await page.locator("form[aria-label='Select labels']").screenshot({ path: join(shots, "picker-preselected.png") });
  await page.locator(`form[aria-label='Select labels'] label:has(input[value='${LABEL}'])`).click();
  expect("clicking the row again takes the suggestion back", !(await page.locator(`form[aria-label='Select labels'] input[value='${LABEL}']`).isChecked()));
  await page.evaluate(() => {
    const details = document.querySelector<HTMLDetailsElement>('form[aria-label="Select labels"] details')!;
    details.open = false;
  });
  await Bun.sleep(300);
  await page.evaluate(() => {
    document.querySelector<HTMLDetailsElement>('form[aria-label="Select labels"] details')!.open = true;
  });
  await Bun.sleep(1000);
  expect("reopened, a suggestion the person took back stays unchecked", !(await page.locator(`form[aria-label='Select labels'] input[value='${LABEL}']`).isChecked()));

  // Signed out, with the stand-in editor gone, an edit is refused with the reason rather than faked.
  await page.evaluate(() => {
    document.querySelector('[name="pull_request[body]"]')?.closest(".stand-in")?.remove();
  });
  // GitHub's signed-in page may name the pull request in other markup than the signed-out one; with neither the header's
  // number nor the document's title to confirm it, a click still goes ahead once the address names this pull request.
  await page.evaluate(() => {
    for (const marker of document.querySelectorAll('[class*="titleSuffix"], .gh-header-number')) marker.remove();
    document.title = "GitHub";
  });
  await page.locator("corbits-triage-sidebar .tb-act[data-kind='edit-body']").click();
  const refused = await until("the refused description edit", async function refusal() {
    const applied = (await stored(worker)).applied as Record<string, Applied> | undefined;
    return Object.entries(applied ?? {}).find(([each, value]) => each.startsWith(key) && each.endsWith(":edit-body") && value.state === "failed")?.[1];
  });
  expect("editing the description signed out, with nothing on the page naming the pull request, is refused only for signing in", refused.error?.includes("Sign in") === true, refused.error);
  await shoot(page, page.locator("corbits-triage-sidebar"), "block-refused");

  // The Files tab: a marker in each flagged file's header and an edge on each flagged line, through in-page navigation.
  await page.locator(`a[href$="/pull/${number}/files"]`).first().click();
  await page.waitForURL(/\/files$/);
  const marker = page.locator("corbits-triage-file-note .file-note").first();
  await marker.waitFor({ state: "visible" });
  const markers = await page.locator("corbits-triage-file-note").count();
  const edged = await page.locator("tr[data-corbits-triage]").count();
  expect("flagged files carry a marker on the Files tab", markers > 0, `${markers} files, ${edged} lines edged`);
  await marker.scrollIntoViewIfNeeded();
  await shoot(page, page.locator(".file-header:has(corbits-triage-file-note)").first(), "files-marker");
  await page.goBack();
  await page.waitForURL(new RegExp(`/pull/${number}$`));
  await block.waitFor({ state: "visible" });
  expect("back on the Conversation tab the block is in place again", true);

  // The guided tour, as the welcome steps start it, through to opening the side panel, at two desktop sizes. Signed in,
  // GitHub's page shows the comment box and Triage fills it while the tour runs, redrawing the block; stand-ins added
  // after the first step do the same here. Every step must spotlight its own part, with the popover beside it.
  for (const [width, height] of [[1440, 900], [2000, 1140]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("about:blank");
    await worker.evaluate((key) => chrome.storage.local.set({ tour: key, "seeds-offered": {}, applied: {} }), key);
    await page.goto(`https://github.com/${repo}/pull/${number}`, { waitUntil: "domcontentloaded" });
    const popover = page.locator(".driver-popover.corbits-tour");
    let step = 0;
    for (;;) {
      await popover.waitFor({ state: "visible", timeout: 60_000 });
      step++;
      if (step === 2) {
        await standInPicker(page);
        await standInComposer(page);
        await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Markdown value"]') as HTMLTextAreaElement | null)?.value);
      }
      // driver.js scrolls to each part and then moves its popover there.
      await Bun.sleep(1200);
      const title = await popover.locator(".driver-popover-title").innerText();
      const placed = await page.evaluate(function measure(title) {
        const shadow = (host: string) => document.querySelector(host)?.shadowRoot;
        const targets: Record<string, () => Element | null | undefined> = {
          "The pull request's score": () => shadow("corbits-triage-chip")?.querySelector(".chip"),
          "Triage in the sidebar": () => shadow("corbits-triage-sidebar")?.querySelector(".tb-summary"),
          "Steps to take": () => shadow("corbits-triage-sidebar")?.querySelector(".tb-steps"),
          "A drafted comment": () => document.querySelector("corbits-triage-composer-seed") ?? shadow("corbits-triage-sidebar")?.querySelector('.tb-act[data-kind="comment"]'),
        };
        const pop = document.querySelector(".driver-popover")!.getBoundingClientRect();
        const inView = pop.left >= 0 && pop.top >= 0 && pop.right <= innerWidth && pop.bottom <= innerHeight;
        const target = targets[title]?.();
        if (!target) return { spotlit: true, apart: true, inView, note: "no element" };
        const rect = target.getBoundingClientRect();
        const apart = pop.right <= rect.left || pop.left >= rect.right || pop.bottom <= rect.top || pop.top >= rect.bottom;
        const visible = rect.top >= 0 && rect.bottom <= innerHeight && rect.height > 0;
        return { spotlit: target.isConnected && target.classList.contains("driver-active-element") && visible, apart, inView, note: `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}` };
      }, title);
      await shoot(page, null, `tour-${width}-${step}`);
      expect(`tour at ${width}px, step ${step} "${title}": its part spotlit and in view, the popover beside it and on screen`, placed.spotlit && placed.apart && placed.inView, JSON.stringify(placed));
      const next = popover.locator(".driver-popover-next-btn");
      const label = await next.innerText();
      await next.click();
      if (label === "Open the side panel") break;
      await page.waitForFunction((at) => !document.querySelector(".driver-popover-progress-text")?.textContent?.startsWith(`${at} of`), step);
    }
    await popover.waitFor({ state: "detached" });
    const panel = await until("the side panel", async function findPanel() {
      const list = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as Array<{ url: string }>;
      return list.find((target) => target.url.endsWith("/sidepanel.html"));
    });
    expect(`at ${width}px the tour ends by opening the side panel`, panel !== undefined, `${step} steps`);
    const pending = (await stored(worker)).tour;
    expect("the tour does not start again", pending == null);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The full-tab workspace on this pull request, with its repository's open pull requests read on demand.
  const workspace = await context.newPage();
  await workspace.goto(`chrome-extension://${extensionId}/workspace.html#${encodeURIComponent(key)}`);
  await workspace.locator(".ws-pr .score-card").waitFor({ state: "visible" });
  await workspace.getByRole("button", { name: "Show its open pull requests" }).first().click();
  await workspace.locator(".ws-repo .hint").first().waitFor({ state: "visible", timeout: 60_000 });
  console.log(`workspace list: ${await workspace.locator(".ws-repo .hint").first().innerText()}`);
  for (const width of [1440, 900]) {
    await workspace.setViewportSize({ width, height: 1000 });
    const sideways = await workspace.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(`the workspace does not scroll sideways at ${width}px`, !sideways);
    await shoot(workspace, null, `workspace-${width}`);
  }
  await workspace.setViewportSize({ width: 1440, height: 1000 });
  await workspace.getByRole("tab", { name: "Rules" }).click();
  await workspace.locator(".manager").waitFor({ state: "visible" });
  await shoot(workspace, null, "workspace-checks");
  await workspace.getByRole("tab", { name: "Settings" }).click();
  await workspace.locator(".settings").waitFor({ state: "visible" });
  await shoot(workspace, null, "workspace-settings");
  await workspace.goto(`chrome-extension://${extensionId}/workspace.html`);
  await workspace.locator(".ws-nav").waitFor({ state: "visible" });
  await shoot(workspace, null, "workspace-empty");
} finally {
  await context.close();
}
if (failed) process.exitCode = 1;
