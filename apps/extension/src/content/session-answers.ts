import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { errorText } from "@corbits/common";
import type { Reply, TabRequest } from "../messages.ts";
import { pageReads, type PageReads } from "../session/page-reads.ts";

// Runs of different pull requests can read through one tab at once; the oldest reader goes past this many.
const READERS = 4;

/** Answers the background's reads from this github.com tab, same-origin, as the person signed in on it. */
export function answerSessionReads(ctx: ContentScriptContext): void {
  const readers = new Map<string, PageReads>();

  /** One run's reads share a reader, so a page its paths both need is fetched once. */
  async function sessionRead({ run, path }: TabRequest, sendResponse: (reply: Reply<string | null>) => void): Promise<void> {
    let reads = readers.get(run);
    if (!reads) {
      reads = pageReads();
      readers.set(run, reads);
      if (readers.size > READERS) readers.delete(readers.keys().next().value!);
    }
    try {
      sendResponse({ ok: true, value: await reads.answer(path) });
    } catch (cause) {
      sendResponse({ ok: false, error: errorText(cause) });
    }
  }

  function onTabMessage(request: TabRequest, _sender: Browser.runtime.MessageSender, sendResponse: (reply: Reply<string | null>) => void): boolean {
    if (request.type !== "session-read") return false;
    sessionRead(request, sendResponse);
    return true;
  }

  browser.runtime.onMessage.addListener(onTabMessage);
  ctx.onInvalidated(function stopAnswering() {
    browser.runtime.onMessage.removeListener(onTabMessage);
  });
}
