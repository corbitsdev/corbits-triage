import { expect, test } from "bun:test";
import type { WorkflowRunEvent } from "@intx/hub-sessions";
import { decideOf, defaultActions, WAITING_KIND, type PolicyWorkflow } from "@corbits/triage-contracts";
import type { TriageJob } from "./coordinator.js";
import { reviewRequestOf, type PullRequestToReview } from "../code-review-feed.js";
import { createPrWorkflowRouter, prWorkflowKeys, workflowPart } from "./pr-workflow.js";
import type { RepoRecord } from "./tenant-config.js";
import { verdictFor } from "./triage-runs.js";

const DECIDE = [{ if: { triage: "fail" as const }, do: "request-changes" as const }];
const RECORD = { name: "acme/widgets", connected: true } as RepoRecord;
const PULL: PullRequestToReview = { title: "t", description: "d", headSha: "abc", draft: false, open: true, diff: "", labels: ["bug"] };
const REVIEW = reviewRequestOf(RECORD, 8, PULL);

type Read = () => Promise<PullRequestToReview>;

function router(keys: string[], { live = true, read = async () => PULL, readDiff = read }: { live?: boolean; read?: Read; readDiff?: Read } = {}) {
  const logged: Array<Record<string, unknown>> = [];
  const diffsRead: number[] = [];
  const route = createPrWorkflowRouter({
    credentials: async () => keys,
    live: async () => live,
    async readHead() {
      const { diff: _diff, ...head } = await read();
      return head;
    },
    readPull(_tenantId, _record, number) {
      diffsRead.push(number);
      return readDiff();
    },
    log(entry) {
      logged.push(entry);
    },
  });
  return { route, logged, diffsRead };
}

function job(policyWorkflow: PolicyWorkflow | undefined, kind = "pr", pauseLabel?: string): TriageJob {
  const payload = { kind, repo: "acme/widgets", automatic: ["comment", "approve", "merge"], ...workflowPart(policyWorkflow), ...(pauseLabel && { pauseLabel }) };
  return { tenantId: "tnt", workflow: "pr-triage-github", repo: "acme/widgets", number: 8, headSha: "abc", source: "event", record: RECORD, payload };
}

test("only a block on, or a decide other than the actions', needs the PR workflow, whose trigger carries the blocks, decide and code review's block", () => {
  const pack = { actions: defaultActions() };
  expect(prWorkflowKeys({ decide: decideOf(pack.actions, false) }, pack)).toBeUndefined();
  expect(prWorkflowKeys({ decide: DECIDE }, pack)).toEqual({ decide: DECIDE });
  expect(prWorkflowKeys({ security: { on: true } }, pack)).toEqual({ security: { on: true } });
  expect(workflowPart({ "code-review": { on: true, for: ["maintainers"], when: { triage: "pass", paths: ["src/**"], rules: "any" }, clean: { below: "high" }, provider: "anthropic" }, decide: DECIDE })).toEqual({
    codeReview: { on: true, for: ["maintainers"], triage: ["pass"], rules: "any", paths: ["src/**"], clean: { below: "high" }, provider: "anthropic" },
    blocks: ["code-review"],
    decide: DECIDE,
  });
  expect(workflowPart({ decide: DECIDE })).toEqual({ codeReview: { on: false, for: ["everyone"], triage: ["pass", "fail", "unsure"], rules: "pass" }, blocks: [], decide: DECIDE });
});

test("code review on with the provider's key runs the host's variant, carrying the review of the head; a decide alone reads no diff", async () => {
  const routed = await router(["anthropic"]).route(job({ "code-review": { on: true }, decide: DECIDE }));
  expect(routed?.workflow).toBe("pr-workflow-anthropic-github");
  expect(routed?.payload).toMatchObject({ blocks: ["code-review"], decide: DECIDE, codeReviewRequest: REVIEW, automatic: ["comment", "approve", "merge"] });
  const decided = await router(["anthropic"]).route(job({ decide: DECIDE }));
  expect(decided?.workflow).toBe("pr-workflow-anthropic-github");
  expect(decided?.payload).not.toHaveProperty("codeReviewRequest");
});

test("a diff that cannot be read is sent without its review, which the run records incomplete", async () => {
  const { route, logged } = router(["anthropic"], { read: async () => Promise.reject(new Error("host down")) });
  const routed = await route(job({ "code-review": { on: true } }));
  expect(routed?.workflow).toBe("pr-workflow-anthropic-github");
  expect(routed?.payload).not.toHaveProperty("codeReviewRequest");
  expect(logged).toMatchObject([{ msg: "pull_request_unread", error: "host down" }]);
});

test("without the provider's key, its variant running, or a variant that runs every block on, pr-triage runs with approve and merge left to a person", async () => {
  const cases = [
    { keys: [], live: true, workflow: { "code-review": { on: true } }, reason: "no_provider_key" },
    { keys: ["anthropic"], live: true, workflow: { "code-review": { on: true, provider: "openai" as const } }, reason: "no_provider_key" },
    { keys: ["anthropic"], live: true, workflow: { security: { on: true } }, reason: "block_not_runnable" },
    { keys: ["anthropic"], live: false, workflow: { decide: DECIDE }, reason: "variant_not_running" },
  ];
  for (const { keys, live, workflow, reason } of cases) {
    const { route, logged } = router(keys, { live });
    const routed = await route(job(workflow));
    expect(routed?.workflow).toBe("pr-triage-github");
    expect(routed?.payload).toMatchObject({ automatic: ["comment"] });
    expect(routed?.payload).not.toHaveProperty("codeReviewRequest");
    expect(logged.map((entry) => [entry.msg, entry.reason])).toEqual([["pr_workflow_unavailable", reason]]);
  }
});

test("a pull request carrying the pause label starts no run, nor does one whose labels can't be read", async () => {
  const paused = router(["anthropic"]);
  expect(await paused.route(job(undefined, "pr", "bug"))).toBeUndefined();
  expect(await paused.route(job({ "code-review": { on: true } }, "pr", "bug"))).toBeUndefined();
  expect(paused.logged.map((entry) => entry.msg)).toEqual(["pr_paused", "pr_paused"]);
  const unread = router(["anthropic"], { read: async () => Promise.reject(new Error("502 Bad Gateway")) });
  await expect(unread.route(job(undefined, "pr", "bug"))).rejects.toThrow("502 Bad Gateway");
  await expect(unread.route(job({ "code-review": { on: true } }, "pr", "bug"))).rejects.toThrow("502 Bad Gateway");
  const bitbucket = job(undefined, "pr", "bug");
  const unlabelled = { ...bitbucket, payload: { ...(bitbucket.payload as object), repoSource: "bitbucket-datacenter" } };
  expect(await unread.route(unlabelled)).toEqual(unlabelled);
  expect(await router(["anthropic"]).route(job(undefined, "pr", "wip"))).toEqual(job(undefined, "pr", "wip"));
});

test("with a pause label, a diff that cannot be read still pauses on the head's labels, or is sent without its review", async () => {
  const { route, logged } = router(["anthropic"], { readDiff: async () => Promise.reject(new Error("502 Bad Gateway")) });
  expect(await route(job({ "code-review": { on: true } }, "pr", "bug"))).toBeUndefined();
  const routed = await route(job({ "code-review": { on: true } }, "pr", "wip"));
  expect(routed?.workflow).toBe("pr-workflow-anthropic-github");
  expect(routed?.payload).not.toHaveProperty("codeReviewRequest");
  expect(logged.map((entry) => entry.msg)).toEqual(["pull_request_unread", "pr_paused", "pull_request_unread"]);
});

test("only code review reads the diff; a pause label alone reads the pull request without it", async () => {
  const paused = router(["anthropic"]);
  expect(await paused.route(job(undefined, "pr", "bug"))).toBeUndefined();
  expect(await paused.route(job({ decide: DECIDE }, "pr", "wip"))).toMatchObject({ workflow: "pr-workflow-anthropic-github" });
  expect(paused.diffsRead).toEqual([]);
  await paused.route(job({ "code-review": { on: true } }, "pr", "wip"));
  expect(paused.diffsRead).toEqual([8]);
});

test("a policy pr-triage runs, and a waiting mail, leave the job as it is", async () => {
  const { route } = router(["anthropic"]);
  for (const sent of [job(undefined), job({ "code-review": { on: true } }, WAITING_KIND)]) {
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
