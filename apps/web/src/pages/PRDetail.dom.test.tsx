import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VerdictDetail } from "@corbits/triage-contracts";
import { projectQueue, type PrItem } from "../lib/hub-api.ts";
import { actionMode } from "../lib/inbox-view.ts";
import * as entities from "../lib/tenant-entities.ts";
import { PullActions } from "./PRDetail.tsx";

const WHEN = "2026-10-26T12:00:00.000Z";

mock.module("../lib/tenant-entities.ts", () => ({ ...entities, useHoldsDos: (dos: unknown[]) => dos.map(() => true) }));

function heldMerge(): PrItem {
  const step = { list: "pass", index: 0, effectId: "effect-0", kind: "merge", held: true, reason: "Size failed.", target: {} };
  const detail = VerdictDetail.assert({ labels: [], feedback: "Please split this.", actions: [step], automatic: [] });
  const recorded = {
    runId: "run-8", at: WHEN, headSha: "abc", verdict: "pass" as const, settled: true, state: "ready-monitoring", actor: "maintainer", humanGated: false,
    degraded: null, commented: true, checks: [], detail,
  };
  const [item] = projectQueue([{ source: "github", repo: "acme/widgets", number: 8, activityAt: null, verdict: recorded, run: null }], [], undefined);
  if (item === undefined) throw new Error("no verdict projected");
  return item;
}

function actions(item: PrItem, closed: boolean): string {
  const controls = { item, closed, approvalPending: false, gated: false, canMerge: true, locked: false, onDecide: () => {}, onWrite: () => {} };
  return renderToStaticMarkup(<PullActions mode={actionMode(item)} controls={controls} onApproveDo={() => {}} onSkipDo={() => {}} />);
}

test("a closed pull request offers no held action and none of your controls", () => {
  const html = actions(heldMerge(), true);
  expect(html).not.toContain(">Skip<");
  expect(html).not.toContain(">Merge<");
});
