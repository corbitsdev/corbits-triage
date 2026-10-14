import { useEffect, useState } from "react";
import { prFromUrl, type PrRef } from "../pr.ts";

export type ActiveTab = { pr: PrRef | undefined };

export function useActivePr(): ActiveTab | undefined {
  const [active, setActive] = useState<ActiveTab>();
  useEffect(function followActiveTab() {
    let live = true;
    async function read() {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (live && tab?.id !== undefined) setActive({ pr: prFromUrl(tab.url) });
    }
    function onActivated() {
      read();
    }
    function onUpdated(_tabId: number, change: Browser.tabs.OnUpdatedInfo) {
      if (change.url !== undefined) read();
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
