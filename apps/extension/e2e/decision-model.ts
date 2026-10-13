// A real decision model call from the Chrome build: the OpenCode Zen preset picked in the first-run steps, then the
// model checks of a real pull request answered by it in this browser, and a rescore answered from those answers
// without asking the model again.
// Run: bun --conditions=intx-src e2e/decision-model.ts <owner/repo> <number> <github token> <OpenCode Zen key>
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import type { TriageView } from "../src/view.ts";

declare const chrome: {
  storage: { local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

// Playwright reports a service worker's requests only with this set.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

const [repo, numberArg, githubToken, decisionKey] = process.argv.slice(2);
if (!repo || !numberArg || !githubToken || !decisionKey) throw new Error("usage: decision-model.ts <owner/repo> <number> <github token> <OpenCode Zen key>");
const key = `${repo}#${numberArg}`;
const shots = resolve(import.meta.dir, "../.output/e2e");

// The copy under test already holds OpenCode's origin, so the permission prompt a headless browser cannot answer resolves at once.
const extension = await mkdtemp(join(tmpdir(), "triage-ext-"));
await cp(resolve(import.meta.dir, "../.output/chrome-mv3"), extension, { recursive: true });
const manifest = await Bun.file(join(extension, "manifest.json")).json();
manifest.host_permissions.push("https://opencode.ai/*");
await Bun.write(join(extension, "manifest.json"), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "triage-e2e-")), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let asked = 0;
context.on("request", function countModelCalls(request) {
  if (request.url().startsWith("https://opencode.ai/")) asked++;
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate((token) => chrome.storage.local.set({ onboarded: true, "github-token": token }), githubToken);
  // The panel's page in a tab of its own, on no pull request, reaches its settings like the side panel does.
  // Without the welcome tab, nothing else becomes the active tab and sends the page back to its home view.
  const welcome = await until("the welcome tab", async () => context.pages().find((each) => each.url().endsWith("/welcome.html")));
  await welcome.close();
  const settings = await context.newPage();
  await settings.goto(new URL("/sidepanel.html", worker.url()).href);
  await settings.getByRole("heading", { name: "Open a pull request" }).waitFor();
  await settings.getByRole("button", { name: "Settings" }).click();
  await settings.getByRole("button", { name: "Choose a provider" }).click();
  await settings.getByRole("radio", { name: /OpenCode Zen/ }).click();
  await settings.getByLabel("OpenCode Zen API key").fill(decisionKey);
  for (const scheme of ["light", "dark"] as const) {
    await settings.emulateMedia({ colorScheme: scheme });
    await Bun.sleep(200);
    await settings.locator("#setting-model").locator("..").screenshot({ path: join(shots, `decision-model-picker-${scheme}.png`) });
  }
  await settings.getByRole("button", { name: "Save decision model" }).click();
  await until("the saved decision model", async () => (await worker.evaluate(async () => (await chrome.storage.local.get("system-one"))["system-one"])) ?? undefined);
  await settings.close();
  const saved = await worker.evaluate(async () => (await chrome.storage.local.get("system-one"))["system-one"] as { endpoint: string; model: string });
  console.log(`saved decision model: ${saved.endpoint} ${saved.model}`);

  const page = await context.newPage();
  await page.goto(`https://github.com/${repo}/pull/${numberArg}`, { waitUntil: "domcontentloaded" });
  const view = await until("a run with the decision model", async function judged() {
    const states = (await worker.evaluate(async () => (await chrome.storage.local.get("run-states"))["run-states"])) as Record<string, { running: boolean; error?: string }> | undefined;
    if (states?.[key]?.error) throw new Error(`triage failed: ${states[key].error}`);
    if (states?.[key]?.running !== false) return undefined;
    return worker.evaluate(async (k) => ((await chrome.storage.local.get("views")).views as Record<string, TriageView> | undefined)?.[k], key);
  });
  const model = view.checks.filter((check) => check.kind === "model");
  console.log(`judge: ${view.judge}, readiness ${view.readiness}`);
  for (const check of model) console.log(`  ${check.name}: ${check.result}, ${check.reason}`);
  if (view.judge !== "asked" || model.length === 0 || model.some((check) => check.result === "needs-judge" || check.reason === "decision model unavailable")) process.exitCode = 1;

  const first = asked;
  const panel = await context.newPage();
  await panel.goto(new URL("/sidepanel.html", worker.url()).href);
  await panel.evaluate((pr) => chrome.runtime.sendMessage({ type: "triage", pr, mode: "rescore" }), { repo, number: Number(numberArg) });
  const again = await until("the rescore", async function rescored() {
    const latest = await worker.evaluate(async (k) => ((await chrome.storage.local.get("views")).views as Record<string, TriageView> | undefined)?.[k], key);
    return latest && latest.ranAt !== view.ranAt ? latest : undefined;
  });
  const same = JSON.stringify(again.checks.filter((check) => check.kind === "model")) === JSON.stringify(model);
  console.log(`first run: ${first} decision model calls; rescore: ${asked - first}, model checks ${same ? "the same" : "DIFFERENT"}, ${Object.keys(view.judged ?? {}).length} answers kept`);
  if (first === 0 || asked !== first || !same || again.judge !== "asked") process.exitCode = 1;
} finally {
  await context.close();
}
