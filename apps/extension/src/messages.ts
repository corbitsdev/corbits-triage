import type { PageAction } from "./page-actions.ts";
import type { PrRef } from "./pr.ts";
import { errorText } from "./error-text.ts";

/** What the pages and the content script ask the background worker; it makes every network call. */
export type Request =
  | { type: "open-panel" }
  /** `if-stale` reuses a recent run, `rescore` re-evaluates the last reads, `refetch` reads GitHub again. */
  | { type: "triage"; pr: PrRef; mode: "if-stale" | "rescore" | "refetch" }
  | { type: "open-prs"; repo: string };

export type Replies = {
  "open-panel": null;
  triage: null;
  "open-prs": OpenPr[];
};

/** A repository's open pull request, as its list shows it. */
export type OpenPr = { number: number; title: string; draft: boolean };

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

export async function ask<R extends Request>(request: R): Promise<Replies[R["type"]]> {
  const reply = (await browser.runtime.sendMessage(request)) as Reply<Replies[R["type"]]> | undefined;
  if (!reply) throw new Error("The extension's background worker did not answer.");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

/** Sent to a GitHub tab: from the panel, a draft for its comment box or an action to apply; from the background, a read for run `run`. */
export type TabRequest =
  /** `key` names the draft, by `actionKey`, so the page can take it back out. */
  | { type: "insert-draft"; key: string; title: string; body: string }
  /** `post` posts a comment action rather than putting it in the comment box. */
  | { type: "apply-action"; pr: PrRef; action: PageAction; post: boolean }
  | { type: "session-read"; run: string; path: string };

export async function tellTab(tabId: number, request: TabRequest): Promise<void> {
  let reply: Reply<null> | undefined;
  try {
    reply = (await browser.tabs.sendMessage(tabId, request)) as Reply<null> | undefined;
  } catch {
    throw new Error("Reload the GitHub tab so Triage can reach it.");
  }
  if (!reply) throw new Error("The GitHub tab did not answer.");
  if (!reply.ok) throw new Error(reply.error);
}

/** For a message whose answer nothing waits on; a failure is logged, never thrown into an event handler. */
export async function send(request: Request): Promise<void> {
  try {
    await ask(request);
  } catch (cause) {
    console.warn(errorText(cause));
  }
}
