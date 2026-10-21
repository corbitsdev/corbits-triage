import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import NewerPortalNotice from "./NewerPortalNotice.tsx";

const realFetch = globalThis.fetch;
// A portal page is named by its entry script, which happy-dom would otherwise try to load.
const browser = (window as unknown as { happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM.settings;
let root: Root | undefined;

afterEach(function restore() {
  act(() => root?.unmount());
  globalThis.fetch = realFetch;
  browser.handleDisabledFileLoadingAsSuccess = false;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

function page(entry: string): string {
  return `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body><div id="root"></div></body></html>`;
}

function serve(html: () => string) {
  globalThis.fetch = async function servePortal() {
    return new Response(html(), { headers: { "content-type": "text/html" } });
  } as unknown as typeof fetch;
}

// Query results reach React on a timer of their own, so each step waits for one.
async function settle(work: () => Promise<unknown> = async () => {}) {
  await act(async () => {
    await work();
    await new Promise((done) => setTimeout(done, 0));
  });
}

test("a tab offers a reload only after the portal is deployed with another build", async () => {
  browser.handleDisabledFileLoadingAsSuccess = true;
  document.head.innerHTML = '<script type="module" crossorigin src="/assets/index-old.js"></script>';
  let deployed = page("/assets/index-old.js");
  serve(() => deployed);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<QueryClientProvider client={client}><NewerPortalNotice /></QueryClientProvider>));
  await settle();
  const status = document.querySelector("[role=status]");
  expect(status?.textContent).toBe("");

  deployed = page("/assets/index-new.js");
  await settle(() => client.refetchQueries());
  expect(document.querySelector("[role=status]")).toBe(status);
  expect(status?.textContent).toContain("A new version of Corbits Triage is available.");
  expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Reload"]);
});
