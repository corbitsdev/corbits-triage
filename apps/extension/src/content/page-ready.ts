import type { PrRef } from "../pr.ts";

// The document's title, "… · Pull Request #12 · owner/repo · GitHub", the same signed in and out.
const TITLE = /Pull Request #(\d+) · ([\w.-]+\/[\w.-]+)/i;
// The pull request's number in the header: the React page's title and its suffix, then the classic page's.
const HEADER_NUMBER = '[data-component="PH_Title"], [class*="titleSuffix"], .gh-header-number';

function titleShows(pr: PrRef): boolean {
  const match = TITLE.exec(document.title);
  return match !== null && Number(match[1]) === pr.number && match[2]!.toLowerCase() === pr.repo.toLowerCase();
}

function headerShows(pr: PrRef): boolean {
  const number = new RegExp(`#${pr.number}(?!\\d)`);
  return [...document.querySelectorAll(HEADER_NUMBER)].some((node) => number.test(node.textContent ?? ""));
}

export function pageShows(pr: PrRef): boolean {
  return titleShows(pr) || headerShows(pr);
}

// After in-page navigation the page catches up with the address within this long; past it, the address is trusted.
const SHOWN_WAIT_MS = 1500;
const SHOWN_POLL_MS = 100;

/** Then goes ahead either way. */
export async function untilPageShows(pr: PrRef): Promise<void> {
  const end = Date.now() + SHOWN_WAIT_MS;
  while (!pageShows(pr) && Date.now() < end) await new Promise((done) => setTimeout(done, SHOWN_POLL_MS));
}
