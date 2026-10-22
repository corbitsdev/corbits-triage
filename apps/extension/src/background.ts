import { errorText } from "@corbits/common";
import { checkPr, pullOf } from "./check-pr.ts";
import { GITHUB_API, githubApi } from "./github-api.ts";
import type { Reply, Request } from "./messages.ts";
import { policyFor } from "./policy-source.ts";
import { prKey } from "./pr.ts";
import { openPanelOnActionClick, openSidePanel } from "./side-panel.ts";
import { clearRunning, githubToken, policyFiles, runStates, saveView, setRunState, tokenSaved, views } from "./storage.ts";
import { FRESH_MS, type TriageView } from "./view.ts";

type Triage = Extract<Request, { type: "triage" }>;

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

function isFresh(view: TriageView | undefined): view is TriageView {
  return view !== undefined && Date.now() - Date.parse(view.ranAt) < FRESH_MS;
}

/** A recent check is reused only while the pull request's head is the one it checked, so a new push is checked again. */
async function triage({ pr, mode }: Triage): Promise<null> {
  const saved = (await views.getValue())[prKey(pr)];
  await setRunState(pr, { running: true });
  try {
    const token = await githubToken.getValue();
    const api = githubApi(token, mode === "refetch" ? "no-cache" : "default");
    const pull = await pullOf(api, pr);
    if (!(mode === "if-stale" && isFresh(saved) && pull.headSha === saved.headSha)) {
      await saveView(await checkPr(api, pr, pull, await policyFor(api, pr.repo, mode === "refetch")));
    }
    await setRunState(pr, { running: false });
  } catch (cause) {
    await setRunState(pr, { running: false, error: errorText(cause) });
  }
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

/** One run per pull request at a time. Another `if-stale` ask joins the run going; a refetch runs after it. */
function triageOnce(request: Triage): Promise<null> {
  const key = prKey(request.pr);
  const current = running.get(key);
  if (current && request.mode === "if-stale") return current;
  const started = current ? afterCurrent(current, request) : triage(request);
  running.set(key, started);
  return finish(key, started);
}

/** GitHub's rate-limit endpoint does not count against the limit, so checking a token costs nothing. */
async function saveToken(token: string): Promise<null> {
  const res = await fetch(`${GITHUB_API}/rate_limit`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error("GitHub did not accept this token. Check that it was copied whole and has not expired.");
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when checking the token. Try again in a moment.`);
  await setToken(token);
  return null;
}

/** Saved checks and policy files were read with the old token, which may have seen repositories the new one cannot. */
async function setToken(token: string | null): Promise<null> {
  await Promise.all([githubToken.setValue(token), tokenSaved.setValue(token !== null), views.setValue({}), runStates.setValue({}), policyFiles.setValue({})]);
  return null;
}

async function handle(request: Exclude<Request, { type: "open-panel" }>): Promise<null> {
  switch (request.type) {
    case "triage":
      return triageOnce(request);
    case "save-token":
      return saveToken(request.token);
    case "remove-token":
      return setToken(null);
  }
}

async function respond(request: Exclude<Request, { type: "open-panel" }>, sendResponse: (reply: Reply<null>) => void): Promise<void> {
  try {
    sendResponse({ ok: true, value: await handle(request) });
  } catch (cause) {
    sendResponse({ ok: false, error: errorText(cause) });
  }
}

function onMessage(request: Request, sender: Browser.runtime.MessageSender, sendResponse: (reply: Reply<null>) => void): boolean {
  if (request.type === "open-panel") {
    openPanel(sender.tab?.windowId);
    sendResponse({ ok: true, value: null });
    return false;
  }
  respond(request, sendResponse);
  return true;
}

/** Checks saved by an older version may not read in this one, and a new version may check differently; rules and the model key it no longer uses are removed. */
async function syncTokenSaved(): Promise<void> {
  await tokenSaved.setValue((await githubToken.getValue()) !== null);
}

function onInstalled({ reason }: Browser.runtime.InstalledDetails): void {
  if (reason === "update") settle(Promise.all([views.setValue({}), runStates.setValue({}), policyFiles.setValue({}), browser.storage.local.remove(["system-one", "packs"]), syncTokenSaved()]));
}

export function startBackground(): void {
  settle(clearRunning());
  browser.runtime.onInstalled.addListener(onInstalled);
  browser.runtime.onMessage.addListener(onMessage);
  settle(openPanelOnActionClick());
}
