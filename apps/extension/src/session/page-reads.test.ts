/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { pageReads } from "./page-reads.ts";

const REPO = "acme/widgets";
const HEAD = "c0ffee".padEnd(40, "0");
const saved = { fetch: globalThis.fetch, location: globalThis.location, DOMParser: globalThis.DOMParser };

const approval = { type: "TIMELINE_ITEM_TYPE_PULL_REQUEST_REVIEW", user: { displayLogin: "x" }, additionalInfo: { pullRequestReview: { state: "approved" } }, timestamp: "2026-10-01T00:00:00Z" };
const comment = { type: "TIMELINE_ITEM_TYPE_ISSUE_COMMENT", user: { displayLogin: "y" }, additionalInfo: { issueComment: { commentId: "1" } }, timestamp: "2026-10-02T00:00:00Z" };

/** github.com with this timeline, and a sidebar whose link for x's latest review points at the head commit. */
function serve(items: unknown[]) {
  globalThis.fetch = async function page(url) {
    const body = String(url).endsWith("/page_data/timeline") ? { items } : { payload: { sidebar: { value: "<html></html>" } } };
    return new Response(JSON.stringify(body));
  } as typeof fetch;
  const link = { id: "review-status-x", getAttribute: () => `/${REPO}/pull/1/commits/${HEAD}` };
  const doc = { querySelectorAll: (selector: string) => (selector.startsWith("a[id^=\"review-status-\"]") ? [link] : []) };
  globalThis.DOMParser = class { parseFromString() { return doc; } } as unknown as typeof DOMParser;
}

beforeEach(() => {
  globalThis.location = { origin: "https://github.com" } as Location;
});

afterEach(() => {
  Object.assign(globalThis, saved);
});

test("a cut timeline's early approval is refused rather than read as one on the head commit", async () => {
  serve([approval, ...Array.from({ length: 24 }, () => comment)]);
  await expect(pageReads().answer(`/repos/${REPO}/pulls/1/reviews`)).rejects.toThrow("shows only the first 25 items");
});

test("a whole timeline's latest review is read on the commit the sidebar names", async () => {
  serve([approval, comment]);
  expect(JSON.parse((await pageReads().answer(`/repos/${REPO}/pulls/1/reviews`))!)).toEqual([{ user: { login: "x" }, state: "APPROVED", submitted_at: "2026-10-01T00:00:00Z", commit_id: HEAD }]);
});
