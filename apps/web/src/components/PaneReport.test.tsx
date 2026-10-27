import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CheckResult, PrItem } from "../lib/hub-api.ts";
import { paneProblems } from "../lib/pane-report.ts";
import { Problems } from "./PaneReport.tsx";

function failed(check: string, reason: string): CheckResult {
  return { check, kind: "machine", result: "fail", reason, evidence: [], output: null, gate: false };
}

function text(check: CheckResult, authorsTurn = false): string {
  const item = { source: "github", repo: "acme/widgets", verdictSha: "head-1" } as PrItem;
  return renderToStaticMarkup(<Problems problems={paneProblems([check], null)} pack={null} item={item} authorsTurn={authorsTurn} />).replace(/<[^>]+>/g, "");
}

test("a problem row names the rule, then its reason, and says To fix only on the author's turn", () => {
  const linked = failed("linked-issue", "pull request does not reference an issue");
  expect(text(linked)).toBe("!Not met: Linked issue: Pull request does not reference an issue.");
  expect(text(linked, true)).toBe("!To fix: Linked issue: Pull request does not reference an issue.");
});

test("a reason that opens with the rule's name as a word is not repeated after it", () => {
  expect(text(failed("no-merge-conflicts", "merge conflicts with base"))).toBe("!Not met: Merge conflicts with base.");
  expect(text(failed("focused", "focusedness is unclear"))).toBe("!Not met: Focused: Focusedness is unclear.");
});

test("a rule to decide does not repeat the status line's Decide before its name", () => {
  const unsure: CheckResult = { check: "focused", kind: "model", result: "unconfirmed", reason: "Triage could not tell whether the changed files serve this pull request.", evidence: [], output: null, gate: false };
  expect(renderToStaticMarkup(<Problems problems={paneProblems([unsure], null)} pack={null} item={{ source: "github", repo: "acme/widgets", verdictSha: "head-1" } as PrItem} authorsTurn={false} />)).toContain('<span class="sr-only">Decide: </span>Focused: Triage could not tell');
});
