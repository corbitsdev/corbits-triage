import { expect, test } from "bun:test";
import { shownBody } from "@corbits/triage-contracts";
import { linearIssues } from "./linked-issue.ts";

function detail(body: string, comments: Array<{ author: string; body: string }> = []) {
  return { pr: { shownBody: body }, commits: [{ message: "fix: retry payouts" }], comments };
}

const URL = "https://linear.app/acme/issue/ENG-42/retry-payouts";

test("a Linear issue links to the URL its bot posted, once per key", () => {
  const bot = { author: "linear[bot]", body: `<a href="${URL}">ENG-42 Retry payouts</a>` };
  expect(linearIssues(detail("Fixes ENG-42", [bot, bot]))).toEqual([{ key: "ENG-42", url: URL }]);
});

test("only the description, commits and Linear's bot link an issue, and a key in two workspaces links none", () => {
  expect(linearIssues(detail("Fixes ENG-7 and UTF-8"))).toEqual([]);
  expect(linearIssues(detail("", [{ author: "someone", body: URL }]))).toEqual([]);
  expect(linearIssues(detail(`${URL} https://linear.app/other/issue/ENG-42`))).toEqual([]);
});

test("only the shown description links an issue, not a URL hidden in an HTML comment", () => {
  const body = `Retry payouts <!-- ${URL} -->`;
  const hidden = { pr: { body, shownBody: shownBody({ body, bodyHtml: "<p>Retry payouts</p>" }, "github") ?? "" }, commits: [], comments: [] };
  const shown = { pr: { body: "Retry payouts", shownBody: `Retry payouts ${URL}` }, commits: [], comments: [] };
  expect(linearIssues(hidden)).toEqual([]);
  expect(linearIssues(shown)).toEqual([{ key: "ENG-42", url: URL }]);
});
