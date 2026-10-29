import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VerdictDetail } from "@corbits/triage-contracts";
import { projectQueue, type PrItem } from "../lib/hub-api.ts";
import { actionMode } from "../lib/inbox-view.ts";
import { PullActions, PullHistory } from "./PRDetail.tsx";

const WHEN = "2026-10-26T12:00:00.000Z";

test("commits come before conversation, and each section names itself when empty", () => {
  const html = renderToStaticMarkup(
    <PullHistory host="GitHub" pending={false} error={null} commits={[]} comments={[]} />,
  );
  const commitsAt = html.indexOf(">Commits<");
  const conversationAt = html.indexOf(">Conversation<");
  expect(commitsAt).toBeGreaterThan(-1);
  expect(conversationAt).toBeGreaterThan(commitsAt);
  expect(html).toContain("No commits.");
  expect(html).toContain("No comments yet.");
});

test("a commit shows its short id and first line, and a comment shows its author and text", () => {
  const html = renderToStaticMarkup(
    <PullHistory
      host="GitHub"
      pending={false}
      error={null}
      commits={[{ sha: "abcdef1234567890", message: "fix: retry payouts\n\nBody stays off the row.", author: "ada", committedAt: WHEN }]}
      comments={[{ id: 7, author: "grace", body: "Looks good", createdAt: WHEN }]}
    />,
  );
  expect(html.indexOf(">Commits<")).toBeLessThan(html.indexOf(">Conversation<"));
  expect(html).toContain("abcdef1");
  expect(html).toContain("fix: retry payouts");
  expect(html).not.toContain("Body stays off the row.");
  expect(html).toContain("ada");
  expect(html).toContain("grace");
  expect(html).toContain("Looks good");
  expect(html).not.toContain("No commits.");
  expect(html).not.toContain("No comments yet.");
});

const FEEDBACK = "Please split this.";

function triaged(verdict: "pass" | "fail", state: string, actions: unknown[], automatic: string[]): PrItem {
  const detail = VerdictDetail.assert({ labels: [], feedback: FEEDBACK, actions, automatic });
  const recorded = {
    runId: "run-8", at: WHEN, headSha: "abc", verdict, settled: true, state, actor: "maintainer", humanGated: false,
    degraded: null, commented: true, checks: [], detail,
  };
  const [item] = projectQueue([{ source: "github", repo: "acme/widgets", number: 8, activityAt: null, verdict: recorded, run: null }], [], undefined);
  if (item === undefined) throw new Error("no verdict projected");
  return item;
}

function step(list: string, kind: string, target: Record<string, unknown>, rest: Record<string, unknown>): Record<string, unknown> {
  return { list, index: 0, effectId: "effect-0", kind, held: false, reason: "Size failed.", target, ...rest };
}

function actions(item: PrItem, closed = false): string {
  const controls = { item, closed, approvalPending: false, gated: false, canMerge: true, locked: false, onDecide: () => {}, onWrite: () => {} };
  return renderToStaticMarkup(<PullActions mode={actionMode(item)} controls={controls} onApproveDo={() => {}} onSkipDo={() => {}} />);
}

test("a policy that acts on its own says what Triage did and why, and offers no Merge", () => {
  const html = actions(triaged("fail", "needs-author-update", [step("fail", "comment", { body: FEEDBACK }, { status: "done" })], ["comment"]));
  expect(html).toContain("Triage commented &quot;Please split this.&quot;. Size failed.");
  expect(html).not.toContain("<button");
});

test("a policy that labels on its own but leaves the merge to you shows what Triage did beside your controls", () => {
  const html = actions(triaged("pass", "ready-monitoring", [step("pass", "labels", { labels: ["triage:ready"] }, { status: "done" })], ["labels"]));
  expect(html).toContain("Triage added label triage:ready.");
  expect(html).toContain(">Merge<");
  expect(html).toContain(">More<");
});

test("a ready pull request whose policy may merge, with no merge step to run, still offers you Merge", () => {
  const html = actions(triaged("pass", "ready-monitoring", [step("pass", "labels", { labels: ["triage:ready"] }, { status: "done" })], ["labels", "merge"]));
  expect(html).toContain("Triage added label triage:ready.");
  expect(html).toContain(">Merge<");
});

test("an automatic action that has not run is described as not posted yet, not as done", () => {
  const html = actions(triaged("fail", "needs-author-update", [step("fail", "comment", { body: FEEDBACK }, {})], ["comment"]));
  expect(html).toContain("Not posted yet: Comment &quot;Please split this.&quot;.");
  expect(html).not.toContain("Triage commented");
});

test.each([["merge", "Merge"], ["approve", "Approve"]])("a held %s waits on you with its own name and Skip beside your controls", (kind, name) => {
  const html = actions(triaged("pass", "ready-monitoring", [step("pass", kind, {}, { held: true })], []));
  expect(html).toMatch(new RegExp(`<div class="suggest">.*>${name}</button>.*>Skip<`));
  expect(html).toContain(">Merge<");
});

test("a closed pull request offers no held action and none of your controls", () => {
  const html = actions(triaged("pass", "ready-monitoring", [step("pass", "merge", {}, { held: true })], []), true);
  expect(html).not.toContain(">Skip<");
  expect(html).not.toContain(">Merge<");
});
