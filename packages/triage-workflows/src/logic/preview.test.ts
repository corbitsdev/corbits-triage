import { expect, test } from "bun:test";
import { emptyPack } from "@corbits/triage-contracts";
import type { ActionInput } from "./actions.js";
import { previewActions } from "./preview.js";

const facts: ActionInput["facts"] = {
  repo: "acme/widgets", number: 8, title: "Add search", author: "octocat", tier: "external", headSha: "abc", state: "open", draft: false,
  mergeable: true, checks: "success", approvals: 0, events: ["opened"],
};

function say(body: string) {
  return [{ kind: "comment" as const, target: { body } }];
}

const pack = { ...emptyPack("acme/widgets"), actions: { when: ["opened" as const], pass: say("pass"), fail: say("fail"), unsure: say("unsure") } };
const input: ActionInput = { facts, checks: [], verdict: "unsure", reason: "needs the judge", pack, roles: {} };

test("previewActions lists every verdict's Dos while it waits on the judge, and none when the event does not wake the policy", () => {
  const waiting = previewActions(input, "waits-on-judge");
  if (waiting.status !== "waits-on-judge") throw new Error("must wait on the judge");
  expect(waiting.lists.map((list) => [list.verdict, list.dos.map((d) => ("target" in d ? d.target : null))])).toEqual([
    ["pass", [{ body: "pass" }]],
    ["fail", [{ body: "fail" }]],
    ["unsure", [{ body: "unsure" }]],
  ]);
  expect(previewActions({ ...input, verdict: "fail" }, [])).toEqual({ status: "decided", verdict: "fail", dos: [] });
  expect(previewActions({ ...input, facts: { ...facts, events: ["commented"] } }, "waits-on-judge")).toEqual({ status: "not-woken" });
});
