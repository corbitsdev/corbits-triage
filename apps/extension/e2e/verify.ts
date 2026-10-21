// End-to-end check of the Chrome build on a real pull request: the chip and the sidebar block appear, the block names
// the policy file and lists every rule the policy runs, and a pull request with no token says how to add one.
// The token is read from standard input, so it never sits on a command line; it is used for GET requests only.
// Run: printenv GITHUB_TOKEN | bun --conditions=intx-src e2e/verify.ts <owner/repo> <number>
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page, type Worker } from "playwright";

declare const chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void>; clear(): Promise<void> } } };

const [repo, numberArg] = process.argv.slice(2);
if (!repo || !numberArg) throw new Error("usage: printenv GITHUB_TOKEN | verify.ts <owner/repo> <number>");
const token = (await Bun.stdin.text()).trim();
if (!token) throw new Error("pipe a GitHub token on standard input");
const url = `https://github.com/${repo}/pull/${numberArg}`;
const extension = resolve(import.meta.dir, "../.output/chrome-mv3");
const shots = resolve(import.meta.dir, "../.output/e2e");

function check(what: string, ok: boolean): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
}

async function blockText(page: Page, selector: string): Promise<string> {
  const block = page.locator("corbits-triage-sidebar").locator(selector);
  await block.first().waitFor({ timeout: 60_000 });
  return (await block.allInnerTexts()).join("\n");
}

async function setToken(worker: Worker, value: string | null): Promise<void> {
  await worker.evaluate(async function store(saved) {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ "github-token": saved });
  }, value);
}

await mkdir(shots, { recursive: true });
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "triage-e2e-")), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();

  await setToken(worker, null);
  await page.goto(url);
  check("without a token, the block says to add one", (await blockText(page, ".tb-warn")).includes("Add a GitHub token"));

  await setToken(worker, token);
  await page.reload();
  const rules = await blockText(page, ".tb-rule");
  const policy = await blockText(page, ".tb-meta");
  const verdict = await blockText(page, ".tb-verdict");
  const chip = await page.locator("corbits-triage-chip").locator(".chip").innerText();
  console.log(`${verdict}\n${policy}\n${rules}`);
  check("the block names the policy file", /Policy: \.corbits-triage\.ya?ml/.test(policy));
  check("the block lists the policy's rules", rules.split("\n").filter(Boolean).length > 0);
  check("the chip and the block agree", chip === `Triage: ${verdict}`);
  check("no rule failed to read", (await page.locator("corbits-triage-sidebar").locator(".tb-warn").count()) === 0);
  await page.locator("corbits-triage-sidebar").locator(".tb").screenshot({ path: join(shots, "settings-extension-pr.png") });
  console.log(`screenshot: ${join(shots, "settings-extension-pr.png")}`);
} finally {
  await context.close();
}
