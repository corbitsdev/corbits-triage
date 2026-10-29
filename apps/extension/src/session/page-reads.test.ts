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

test("open pull requests into a base are listed from the dashboard filtered on it, and none open reads as none", async () => {
  const asked: string[] = [];
  globalThis.fetch = async function dashboard(url) {
    asked.push(decodeURIComponent(String(url)));
    const route = String(url).includes("base") ? { currentPage: 1, openCount: 0, closedCount: 0 } : { results: [{ number: 4, title: "T", displayState: "REPO_PULL_REQUEST_DISPLAY_STATE_OPEN", headSha: HEAD, labels: [] }], totalPages: 1, openCount: 1 };
    return new Response(JSON.stringify({ payload: { repoPullsDashboardContentRoute: route } }));
  } as typeof fetch;
  expect(JSON.parse((await pageReads().answer(`/repos/${REPO}/pulls?state=open&base=main&per_page=100`))!)).toEqual([]);
  expect(JSON.parse((await pageReads().answer(`/repos/${REPO}/pulls?state=open&per_page=100`))!)).toMatchObject([{ number: 4 }]);
  expect(asked[0]).toContain('q=is:pr is:open base:"main"');
});

test("the mergeability read encodes the head branch like the base, keeping a fork's owner prefix", async () => {
  const asked: string[] = [];
  function servePull(headBranch: string, headRepositoryOwnerLogin: string) {
    globalThis.fetch = async function pullPage(url) {
      const path = String(url);
      asked.push(path);
      const pullRequest = { state: "OPEN", baseBranch: "main", headBranch, headRepositoryOwnerLogin, headSha: HEAD, title: "T", author: { login: "x" } };
      const bodies: Record<string, unknown> = {
        header: { pullRequest },
        description: { body: "", bodyHtml: "" },
        diffstat: { diffstat: { linesAdded: 0, linesDeleted: 0 } },
        tab_counts: { filesChangedCount: 0 },
      };
      const body = bodies[path.split("/").at(-1)!] ?? { state: "clean", payload: { sidebar: { value: "" }, repoPullsDashboardContentRoute: { results: [{ number: 1, author: { association: "OWNER" } }] } } };
      return new Response(JSON.stringify(body));
    } as typeof fetch;
    globalThis.DOMParser = class { parseFromString() { return { querySelectorAll: () => [] }; } } as unknown as typeof DOMParser;
  }
  for (const [branch, owner] of [["fix#1", "acme"], ["100%", "acme"], ["fix#1", "fork"]]) {
    servePull(branch, owner);
    await pageReads().answer(`/repos/${REPO}/pulls/1`);
  }
  expect(asked.filter((url) => url.includes("pre_mergeable"))).toEqual([
    `/${REPO}/branches/pre_mergeable/main...fix%231`,
    `/${REPO}/branches/pre_mergeable/main...100%25`,
    `/${REPO}/branches/pre_mergeable/main...fork:fix%231`,
  ]);
});
