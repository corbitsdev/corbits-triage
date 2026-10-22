import { useEffect, useState } from "react";
import { prFromUrl, type PrRef } from "../pr.ts";

export type ActiveTab = { tabId: number; pr: PrRef | undefined; title: string };

/** The pull request in this window's active tab, following tab switches and in-page navigation. */
export function useActivePr(): ActiveTab | undefined {
  const [active, setActive] = useState<ActiveTab>();
  useEffect(function followActiveTab() {
    let live = true;
    async function read() {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (live && tab?.id !== undefined) setActive({ tabId: tab.id, pr: prFromUrl(tab.url), title: tab.title ?? "" });
    }
    function onActivated() {
      read();
    }
    function onUpdated(_tabId: number, change: Browser.tabs.OnUpdatedInfo) {
      if (change.url !== undefined || change.title !== undefined) read();
    }
    read();
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    return function stop() {
      live = false;
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);
  return active;
}
