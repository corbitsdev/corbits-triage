import { GithubRateLimitError, publicGithub, type PublicGithub } from "./github-public.ts";
import { runLocal } from "./local-run.ts";
import type { OpenPr, Reply, Request } from "./messages.ts";
import { localPackFor } from "./pack-store.ts";
import { prFromUrl, prKey, type PrRef } from "./pr.ts";
import { sessionGithub, type GithubReads } from "./session-github.ts";
import { openPanelOnActionClick, openSidePanel } from "./side-panel.ts";
import { clearRunning, githubToken, saveView, setRunState, systemOne, views } from "./storage.ts";
import type { Judged } from "@corbits/triage-workflows/logic/item";
import { FRESH_MS, type Ended, type TriageView } from "./view.ts";
import { errorText } from "./error-text.ts";

type Triage = Extract<Request, { type: "triage" }>;

/** The last run's GitHub reads per pull request, so a pack change re-scores without spending more of the hourly limit. */
const reads = new Map<string, GithubReads>();
const running = new Map<string, Promise<null>>();

async function settle(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (cause) {
    console.warn(errorText(cause));
  }
}

/** Opened in the same turn as the click's message: the side panel opens only inside a user gesture. */
function openPanel(windowId: number | undefined): void {
  if (windowId !== undefined) settle(openSidePanel(windowId));
}

async function badgeFor(tabId: number, url: string | undefined): Promise<void> {
  const pr = prFromUrl(url);
  const view = pr ? (await views.getValue())[prKey(pr)] : undefined;
  await browser.action.setBadgeBackgroundColor({ tabId, color: "#E98428" });
  await browser.action.setBadgeText({ tabId, text: view?.dos.length ? String(view.dos.length) : "" });
}

async function badgeTabsOf(pr: PrRef): Promise<void> {
  const tabs = await browser.tabs.query({ url: `https://github.com/${pr.repo}/pull/${pr.number}*` });
  for (const tab of tabs) if (tab.id !== undefined) await badgeFor(tab.id, tab.url);
}

function isFresh(view: TriageView | undefined): boolean {
  return view !== undefined && Date.now() - Date.parse(view.checkedAt ?? view.ranAt) < FRESH_MS;
}

/** GitHub's API only with the person's own token: without one, reads never spend the limit shared by requests without a token. */
async function tokenApi(cache: RequestCache): Promise<PublicGithub | null> {
  const token = await githubToken.getValue();
  return token ? publicGithub(cache, token) : null;
}

/** A rescore replays the last run's reads; anything else reads GitHub again, as the signed-in person first. */
async function readsFor(pr: PrRef, mode: Triage["mode"]): Promise<GithubReads> {
  const kept = mode === "rescore" ? reads.get(prKey(pr)) : undefined;
  return kept ?? sessionGithub(pr, await tokenApi(mode === "refetch" ? "no-cache" : "default"));
}

async function endedOf(github: GithubReads, pr: PrRef): Promise<Ended | undefined> {
  const res = await github.gh(`/repos/${pr.repo}/pulls/${pr.number}`);
  if (!res.ok) throw new Error(`github ${pr.repo}#${pr.number} -> ${res.status}`);
  const read = (await res.json()) as { state?: string; merged?: boolean; merged_at?: string | null };
  if (read.state !== "closed") return undefined;
  return read.merged === true || Boolean(read.merged_at) ? "merged" : "closed";
}

/** Answers are reused only from the same decision model; each is keyed by the exact request it answered, so a changed pull request is asked again. */
function judgedFor(previous: TriageView | undefined, by: string | undefined): Judged | undefined {
  return previous?.judged && by !== undefined && previous.judgedBy === by ? previous.judged : undefined;
}

async function localView(pr: PrRef, github: GithubReads, previous: TriageView | undefined): Promise<TriageView> {
  const [pack, settings] = await Promise.all([localPackFor(pr.repo), systemOne.getValue()]);
  const by = settings ? `${settings.endpoint} ${settings.model}` : undefined;
  const judged = judgedFor(previous, by);
  const run = await runLocal(pr, { gh: github.gh, pack, docs: github.docs, ...(settings ? { systemOne: settings } : {}), ...(judged ? { judged } : {}) });
  const view = run.judged && by ? { ...run, judgedBy: by } : run;
  const ended = await endedOf(github, pr);
  const rate = github.rate();
  return { ...view, reads: github.counts(), ...(rate ? { rate } : {}), ...(ended ? { ended } : {}) };
}

async function triage({ pr, mode }: Triage): Promise<null> {
  const existing = (await views.getValue())[prKey(pr)];
  if (mode === "if-stale" && isFresh(existing)) return null;
  await setRunState(pr, { running: true });
  let head: string | undefined;
  try {
    const github = await readsFor(pr, mode);
    // A head already scored is scored again only when the person asks, so coming back to it costs one call.
    if (mode === "if-stale" && existing) head = await github.head();
    if (existing && head === existing.headSha) {
      await saveView({ ...existing, checkedAt: new Date().toISOString(), rate: github.rate() ?? existing.rate });
    } else {
      await saveView(await localView(pr, github, existing));
      reads.set(prKey(pr), github);
    }
    await setRunState(pr, { running: false });
  } catch (cause) {
    reads.delete(prKey(pr));
    await setRunState(pr, {
      running: false,
      error: errorText(cause),
      ...(cause instanceof GithubRateLimitError ? { resetAt: cause.resetAt } : {}),
      ...(head ? { head } : {}),
    });
  }
  await badgeTabsOf(pr);
  return null;
}

async function finish(key: string, started: Promise<null>): Promise<null> {
  try {
    return await started;
  } finally {
    if (running.get(key) === started) running.delete(key);
  }
}

async function afterCurrent(current: Promise<null>, request: Triage): Promise<null> {
  try {
    await current;
  } catch {
    // The run that failed recorded its own error; this one starts clean.
  }
  return triage(request);
}

/**
 * One triage per pull request at a time. Another `if-stale` ask joins the run already going; a rescore or refetch
 * runs after it, since the change it carries (a pack, a key, a Do just run) came after that run read its inputs.
 */
function triageOnce(request: Triage): Promise<null> {
  const key = prKey(request.pr);
  const current = running.get(key);
  if (current && request.mode === "if-stale") return current;
  const started = current ? afterCurrent(current, request) : triage(request);
  running.set(key, started);
  return finish(key, started);
}

// The newest open pull requests a repository lists, one page of GitHub's list.
const NEWEST_OPEN = 25;

async function openPrs(repo: string): Promise<OpenPr[]> {
  const github = await sessionGithub({ repo }, await tokenApi("no-cache"));
  const res = await github.gh(`/repos/${repo}/pulls?state=open&per_page=${NEWEST_OPEN}`);
  if (!res.ok) throw new Error(`GitHub did not list ${repo}'s open pull requests (${res.status}).`);
  const rows = (await res.json()) as Array<{ number: number; title?: string; draft?: boolean }>;
  return rows.slice(0, NEWEST_OPEN).map((row) => ({ number: row.number, title: row.title ?? "", draft: row.draft === true }));
}

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case "open-prs":
      return openPrs(request.repo);
    case "triage":
      return triageOnce(request);
  }
}

async function respond(request: Request, sendResponse: (reply: Reply<unknown>) => void): Promise<void> {
  try {
    sendResponse({ ok: true, value: await handle(request) });
  } catch (cause) {
    sendResponse({ ok: false, error: errorText(cause) });
  }
}

function onMessage(request: Request, sender: Browser.runtime.MessageSender, sendResponse: (reply: Reply<unknown>) => void): boolean {
  if (request.type === "open-panel") {
    openPanel(sender.tab?.windowId);
    sendResponse({ ok: true, value: null });
    return false;
  }
  respond(request, sendResponse);
  return true;
}

function onTabUpdated(tabId: number, change: Browser.tabs.OnUpdatedInfo, tab: Browser.tabs.Tab): void {
  if (change.url !== undefined || change.status === "complete") settle(badgeFor(tabId, tab.url));
}

function onInstalled({ reason }: Browser.runtime.InstalledDetails): void {
  if (reason === "install") settle(browser.tabs.create({ url: browser.runtime.getURL("/welcome.html") }));
}

export function startBackground(): void {
  settle(clearRunning());
  // Kept reads carry the token they were made with.
  githubToken.watch(function onTokenChange() {
    reads.clear();
  });
  browser.runtime.onMessage.addListener(onMessage);
  browser.tabs.onUpdated.addListener(onTabUpdated);
  browser.runtime.onInstalled.addListener(onInstalled);
  settle(openPanelOnActionClick());
}
