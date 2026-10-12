import { expect, test } from "bun:test";
import { linearIssues } from "./linked-issue.ts";

function detail(body: string, comments: Array<{ author: string; body: string }> = []) {
  return { pr: { body }, commits: [{ message: "fix: retry payouts" }], comments };
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
