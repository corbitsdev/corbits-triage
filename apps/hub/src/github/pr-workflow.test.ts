import { expect, test } from "bun:test";
import type { WorkflowRunEvent } from "@intx/hub-sessions";
import { decideOf, defaultActions, type PolicyWorkflow } from "@corbits/triage-contracts";
import type { PullRequestToReview } from "../pull-request-reader.js";
import { createPauseGate, prWorkflowKeys, workflowPart } from "./pr-workflow.js";
import type { RepoRecord } from "./tenant-config.js";
import { verdictFor } from "./triage-runs.js";

const DECIDE = [{ if: { triage: "fail" as const }, do: "request-changes" as const }];
const RECORD = { name: "acme/widgets", connected: true } as RepoRecord;
const PULL: PullRequestToReview = { title: "t", description: "d", headSha: "abc", draft: false, open: true, diff: "", labels: ["bug"] };

type Read = () => Promise<PullRequestToReview>;

function gate(read: Read = async () => PULL) {
  const logged: Array<Record<string, unknown>> = [];
  const pass = createPauseGate({
    async readHead() {
      const { diff: _diff, ...head } = await read();
      return head;
    },
    log(entry) {
      logged.push(entry);
    },
  });
  function route(request: Record<string, unknown>) {
    return pass("tnt", RECORD, 8, request);
  }
  return { route, logged };
}

function job(policyWorkflow: PolicyWorkflow | undefined, kind = "pr", pauseLabel?: string): Record<string, unknown> {
  return { kind, repo: "acme/widgets", headSha: "abc", automatic: ["comment", "approve", "merge"], ...workflowPart(policyWorkflow), ...(pauseLabel && { pauseLabel }) };
}

test("only a block on, or a decide other than the actions', needs the PR workflow, whose trigger carries the blocks, decide and code review's block", () => {
  const pack = { actions: defaultActions() };
  expect(prWorkflowKeys({ decide: decideOf(pack.actions, false) }, pack)).toBeUndefined();
  expect(prWorkflowKeys({ decide: DECIDE }, pack)).toEqual({ decide: DECIDE });
  expect(prWorkflowKeys({ "code-review": { on: true } }, pack)).toEqual({ "code-review": { on: true } });
  expect(workflowPart({ "code-review": { on: true, for: ["maintainers"], when: { triage: "pass", paths: ["src/**"], rules: "any" }, clean: { below: "high" }, provider: "anthropic" }, decide: DECIDE })).toEqual({
    codeReview: { on: true, for: ["maintainers"], triage: ["pass"], rules: "any", paths: ["src/**"], clean: { below: "high" }, provider: "anthropic" },
    blocks: ["code-review"],
    decide: DECIDE,
  });
  expect(workflowPart({ decide: DECIDE })).toEqual({ codeReview: { on: false, for: ["everyone"], triage: ["pass", "fail", "unsure"], rules: "pass" }, blocks: [], decide: DECIDE });
});

test("a pull request carrying the pause label on GitHub starts no run, and one whose labels can't be read throws to be retried", async () => {
  const { route, logged } = gate();
  expect(await route(job(undefined, "pr", "bug"))).toBeUndefined();
  expect(logged.map((entry) => entry.msg)).toEqual(["pr_paused"]);
  expect(await route(job(undefined, "pr", "wip"))).toEqual(job(undefined, "pr", "wip"));
  const unread = gate(async () => Promise.reject(new Error("502 Bad Gateway")));
  await expect(unread.route(job(undefined, "pr", "bug"))).rejects.toThrow("502 Bad Gateway");
  const bitbucket = job(undefined, "pr", "bug");
  const unlabelled = { ...bitbucket, repoSource: "bitbucket-datacenter" };
  expect(await unread.route(unlabelled)).toEqual(unlabelled);
});

test("a policy writing its own decide leaves approve and merge to a person; code review alone leaves the job as it is", async () => {
  const { route } = gate();
  expect(await route(job({ decide: DECIDE }))).toMatchObject({ automatic: ["comment"] });
  for (const sent of [job(undefined), job({ "code-review": { on: true } })]) {
    expect(await route(sent)).toEqual(sent);
  }
});

function completed(seq: number, stepId: string, output: unknown): WorkflowRunEvent {
  return { seq, type: "StepCompleted", body: { type: "StepCompleted", seq, at: "2026-10-20T00:00:00.000Z", stepId, output: { ref: `inline:${JSON.stringify(output)}` } } } as WorkflowRunEvent;
}

test("the hub reads a PR workflow run's Dos from decide: those it made, then evaluate's it left held for a maintainer", () => {
  const approve = { list: "pass", index: 0, kind: "approve", effectId: "e1", target: {} };
  const comment = { list: "pass", index: 1, kind: "comment", effectId: "e2", target: {} };
  const labels = { list: "pass", index: 2, kind: "labels", effectId: "e3", target: {} };
  const flagged = "Flagged for a maintainer: code-review is incomplete.";
  const verdict = { repo: "acme/widgets", number: 8, headSha: "abc", verdict: "pass" };
  const events = [
    completed(1, "evaluate", { ...verdict, actions: [approve, comment] }),
    completed(2, "decide", { decision: { flag: "code-review is incomplete" }, verdict: { ...verdict, actions: [labels] }, held: [{ effectId: "e1", status: "held", error: flagged }] }),
    completed(3, "execute", { dos: [{ effectId: "e3", status: "done" }, { effectId: "e1", status: "held", error: flagged }] }),
  ];
  expect(verdictFor(events, "acme/widgets", 8)?.["actions"]).toEqual([{ ...labels, status: "done" }, { ...approve, held: true, reason: flagged }]);
});

test("on a flag, a Do triage held for a missing grant still waits in Needs you with its reason", () => {
  const merge = { list: "pass", index: 0, kind: "merge", effectId: "e1", target: {}, held: true, reason: "Merging needs the merge grant." };
  const comment = { list: "pass", index: 1, kind: "comment", effectId: "e2", target: {} };
  const verdict = { repo: "acme/widgets", number: 8, headSha: "abc", verdict: "pass" };
  const events = [
    completed(1, "evaluate", { ...verdict, actions: [merge, comment] }),
    completed(2, "decide", { decision: { flag: "nothing matched" }, verdict: { ...verdict, actions: [] }, held: [{ effectId: "e2", status: "held", error: "Flagged for a maintainer: nothing matched." }] }),
  ];
  expect(verdictFor(events, "acme/widgets", 8)?.["actions"]).toEqual([merge, { ...comment, held: true, reason: "Flagged for a maintainer: nothing matched." }]);
});
