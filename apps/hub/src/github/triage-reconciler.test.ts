import { describe, expect, test } from "bun:test";
import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { decodeMail, extractAddrSpec } from "@intx/mime";
import { formatRunAddress } from "@intx/types";
import { workflowRunRepoIdForAddress, type RepoId, type WorkflowRunEvent, type WorkflowRunReader } from "@intx/hub-sessions";
import { emptyPack, stockTriggerMail, type ActionKind, type CheckPack, type PrTriageRow } from "@corbits/triage-contracts";
import type { CheckRun } from "@corbits/github-reads";
import { DEFAULT_RECONCILE_POLICY, planTenant, type ObservedRun, type OpenPr } from "./reconcile-plan.js";
import { triageReconcilePolicy } from "../env.js";
import { TriageStateConflictError, type TriageStateStore } from "./triage-state-store.js";
import { createRunTriggerDeliverer } from "@corbits/webhooks";
import type { LiveDeployment } from "./deployment.js";
import type { RotationRecord } from "./tenant-config.js";
import { createRunRecorder } from "./run-recorder.js";
import { createTenantObserver, createTenantVersions } from "./tenant-observer.js";
import type { ApprovedDo, RecordedVerdict, VerdictRecord } from "./verdict-record-store.js";
import { createTriageReconciler } from "./triage-reconciler.js";
import { createRepoActivity, type RepoActivity } from "./repo-activity.js";
import { GithubRateLimited } from "./github-usage.js";
import { markBaseMoved } from "./triage-queue.js";
import { createTriageRuns, verdictFor } from "./triage-runs.js";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { evaluate, parts, rules } from "@corbits/triage-workflows/actions/index";
import { readFacts } from "@corbits/triage-workflows/actions/facts";
import type { JudgeChunk } from "@corbits/triage-workflows/actions/rules";
import type { Verdict } from "@corbits/triage-workflows/logic/render";

const REPO = "acme/widgets";
const DOMAIN = "acme.test";
const TENANT_ID = "tnt_acme";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const LONG_AGO = "2026-10-07T00:00:00.000Z";
const VERSION = "0.1.0-sha-11111111";
const OFFERING = "off_decision";
const LIVE = deployment("run_live", new Date(LONG_AGO));
const MINUTE = 60_000;
const BASE_MOVE_WINDOW = DEFAULT_RECONCILE_POLICY.baseMoveWindowMs / MINUTE;

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * MINUTE);
}
let failNextList = false;

function deployment(runId: string, createdAt: Date): LiveDeployment {
  return { runId, address: formatRunAddress(runId, DOMAIN), createdAt, cancelling: false, workflowVersion: VERSION, offeringId: OFFERING };
}

function repoKey(anchorRunId: string): string {
  return workflowRunRepoIdForAddress(formatRunAddress(anchorRunId, DOMAIN)).id;
}

function head(number: number): OpenPr {
  return { number, headSha: `sha${number}`, updatedAt: LONG_AGO, draft: false };
}

function heads(from: number, count: number): OpenPr[] {
  return Array.from({ length: count }, (_, i) => head(from + i));
}

function startedBy(payload: unknown, at: string): WorkflowRunEvent {
  return { seq: 0, type: "RunStarted", body: { type: "RunStarted", seq: 0, at, trigger: { type: "mail", payload } } };
}

function started(number: number, at = "2026-10-07T01:00:00.000Z"): WorkflowRunEvent {
  return startedBy(stockTriggerMail({ kind: "pr", repo: REPO, prNumber: number, headSha: `sha${number}` }), at);
}

function startedBatch(numbers: number[], at = "2026-10-07T01:00:00.000Z"): WorkflowRunEvent {
  return startedBy(stockTriggerMail({ kind: "pr", repo: REPO, items: numbers.map((number) => ({ prNumber: number, headSha: `sha${number}` })) }), at);
}

function current(number: number): Record<string, unknown> {
  return { degraded: null, reason: "", headSha: `sha${number}`, checks: [] };
}

function replied(stepId: string, reply: Record<string, unknown>): WorkflowRunEvent {
  const output = { ref: `inline:${JSON.stringify({ reply: JSON.stringify(reply), turn: 1 })}` };
  return { seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, at: "2026-10-07T01:30:00.000Z", stepId, output } };
}

function rendered(verdict: Record<string, unknown>): WorkflowRunEvent {
  return replied("render", verdict);
}

const completed: WorkflowRunEvent = { seq: 2, type: "RunCompleted", body: { type: "RunCompleted", seq: 2 } };

type Logs = Record<string, Record<string, WorkflowRunEvent[]>>;
type Delivered = Array<{ payload: Record<string, unknown> }>;

function mailedHeads(delivered: Delivered): Array<[string, number]> {
  return delivered.flatMap((entry) => (entry.payload["items"] as Array<{ prNumber: number }>).map((item): [string, number] => [entry.payload["repo"] as string, item.prNumber]));
}

function mailedNumbers(delivered: Delivered): number[] {
  return mailedHeads(delivered).map(([, number]) => number);
}

function githubAnswer({ id, name }: ToolCall, pr: Record<string, unknown>): Record<string, unknown> {
  const n = Number(id.split(":")[1]);
  switch (name) {
    case "github_list_open_prs":
      return { prs: [1, 2, 3].map((number) => ({ number, title: `PR ${number}` })) };
    case "github_read_repo_docs":
      return { docs: [], rules: [], ref: "tree" };
    case "github_get_pr":
      return { title: `PR ${n}`, author: "octocat", sha: `sha${n}`, state: "open", draft: false, requestedReviewers: 0, ...pr };
    case "github_list_pr_files":
      return { files: [{ path: `src/pr${n}.ts`, status: "modified", patch: `@@ -0,0 +1 @@\n+export const pr${n} = ${n};` }] };
    case "github_get_reviews":
      return { reviews: [] };
    case "github_list_pr_commits":
      return { commits: [] };
    case "github_list_issue_comments":
      return { comments: [] };
    case "github_get_checks":
      return { checks: [] };
    case "github_get_stack":
      return { includes: [] };
  }
  throw new Error(`unexpected call ${name}`);
}

function focusedAnswers(questions: Array<{ id: string }>, related: number): string {
  const rest = (1 - related) / 2;
  const probabilities: Record<string, Record<string, number>> = {
    focused: { one_thing: related, more_than_one_thing: rest, cant_tell: rest },
    verdict: { pass: related, fail: rest, cant_tell: rest },
  };
  return questions.map(({ id }) => JSON.stringify({ id, type: "choice", choice: Object.keys(probabilities[id]!)[0], probabilities: probabilities[id], confidence: 0.9 })).join("");
}

async function triageMail(mail: unknown, pr: Record<string, unknown>, related = 0.8) {
  async function github(asked: ToolCall): Promise<ToolResult> {
    return { callId: asked.id, content: githubAnswer(asked, pr) };
  }
  const read = await readFacts(mail, () => github);
  const ctx = {} as never;
  const signal = new AbortController().signal;
  const ruled = await rules(read, ctx, signal);
  function answer(chunks: JudgeChunk[]) {
    return chunks.map((chunk) => ({ reply: JSON.stringify({ judge: focusedAnswers(chunk.questions, related) }) }));
  }
  const judged = { ...ruled, judge: { output: answer(ruled.chunks) } };
  const { chunks } = await parts(judged, ctx, signal);
  const verdicts = await evaluate(ruled.needsJudgment ? { ...judged, judgeParts: { output: answer(chunks) } } : ruled, ctx, signal) as { items: Verdict[] };
  return { asked: ruled.chunks.length, verdicts: verdicts.items };
}

function evaluated(output: unknown): WorkflowRunEvent {
  return { seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, at: "2026-10-07T01:30:00.000Z", stepId: "evaluate", output: { ref: `inline:${JSON.stringify(output)}` } } };
}

function fakeReader(logs: Logs) {
  const reads: Array<{ repo: string; runId: string }> = [];
  const latestOf: string[][] = [];
  const reader: WorkflowRunReader = {
    async listRunIds(repoId: RepoId) {
      return Object.keys(logs[repoId.id] ?? {});
    },
    async readRunEvents(repoId: RepoId, _ref: string, runId: string) {
      reads.push({ repo: repoId.id, runId });
      return logs[repoId.id]?.[runId] ?? [];
    },
    async readLatestRunEvents(repoId: RepoId, _ref: string, include: (runId: string) => boolean) {
      const events = new Map<string, WorkflowRunEvent | null>();
      for (const [runId, log] of Object.entries(logs[repoId.id] ?? {})) {
        if (include(runId)) events.set(runId, log.at(-1) ?? null);
      }
      latestOf.push([repoId.id, ...events.keys()]);
      return { tip: "tip", events };
    },
    async resolveRefTip() {
      return "tip";
    },
    async hasRepository() {
      return true;
    },
  };
  return { reader, reads, latestOf };
}

type HarnessOptions = {
  github?: boolean;
  maxInFlight?: string;
  refuseSaves?: number;
  onRefusedSave?: (repo: string) => void;
  rotateAfterRuns?: number;
  now?: () => Date;
  deployments?: LiveDeployment[];
  whileRedeploying?: (deployments: LiveDeployment[]) => void;
  rotation?: RotationRecord;
  sameSource?: boolean;
  pack?: CheckPack;
  automatic?: ActionKind[];
  noPack?: boolean;
  /** Build statuses of every head, for a host whose builds the reconciler polls. */
  headChecks?: CheckRun[];
  /** Stored triage state of the repository before the first pass. */
  rows?: PrTriageRow[];
  /** Verdicts recorded from runs no live log holds any more. */
  recorded?: VerdictRecord[];
  activity?: RepoActivity;
  /** Thrown by every listing of open pull requests while set. */
  listError?: Error;
};

function harness(logs: Logs, prs: OpenPr[] | Record<string, OpenPr[]>, options: HarnessOptions = {}) {
  const repos = Array.isArray(prs) ? { [REPO]: prs } : prs;
  const records = { rotation: options.rotation };
  function tenant() {
    const ns = { repos: Object.keys(repos).map((name) => ({ name, connected: true, enabled: true })), ...(records.rotation && { rotation: records.rotation }) };
    return { id: TENANT_ID, domain: DOMAIN, config: { corbitsTriage: ns } };
  }
  const { reader, reads, latestOf } = fakeReader(logs);
  const delivered: Delivered = [];
  const saved = new Map<string, PrTriageRow[]>(options.rows ? [[REPO, options.rows]] : []);
  let refusals = options.refuseSaves ?? 0;
  const logged: Array<Record<string, unknown>> = [];
  const listings: string[] = [];
  const now = options.now ?? (() => NOW);
  const deployments = (options.deployments ?? [LIVE]).map((live) => ({ ...live }));
  const released: string[] = [];
  const verdicts: RecordedVerdict[] = [];
  const approved: ApprovedDo[] = [];
  async function liveDeployments() {
    if (failNextList) {
      failNextList = false;
      throw new Error("transient list failure");
    }
    return deployments.map((live) => ({ ...live }));
  }
  const observer = createTenantObserver({
    liveDeployments,
    observeRuns: createTriageRuns({ runReader: reader, readSettled: async () => new Map(), maxKnownRuns: 100 }),
    recordRuns: createRunRecorder({
      verdicts: {
        async record(_tenantId, recorded) {
          verdicts.push(...recorded);
        },
        async recordApproved(_tenantId, outcomes) {
          approved.push(...outcomes);
        },
      },
      log: () => {},
    }),
    versions: createTenantVersions(),
    minIntervalMs: 0,
    now,
  });
  const reconcile = createTriageReconciler({
    source: "github",
    rotationKey: "rotation",
    tenants: async function tenants() {
      return [tenant()];
    },
    liveDeployments,
    latestDeployments: async () => [],
    rotation: {
      afterRuns: options.rotateAfterRuns ?? 1_000,
      async redeploy(_tenantId, anchorRunId) {
        const runId = `${anchorRunId}_fresh`;
        options.whileRedeploying?.(deployments);
        deployments.unshift(deployment(runId, now()));
        return { status: "deployed", runId };
      },
      async sameSource() {
        return options.sameSource ?? false;
      },
      // Like the stock cancellation request, the deployment stays live until the lifecycle sweep stops it.
      async release(_tenantId, anchorRunId) {
        released.push(anchorRunId);
        deployments.find((live) => live.runId === anchorRunId)!.cancelling = true;
      },
      async claim(_tenantId, record) {
        if (records.rotation) return false;
        records.rotation = record;
        return true;
      },
      async clear(_tenantId, record) {
        if (records.rotation?.from === record.from && records.rotation.to === record.to) records.rotation = undefined;
      },
    },
    openHeadsFor: async function openHeadsFor() {
      if (options.github === false) return undefined;
      return async function openHeads(record) {
        listings.push(record.name);
        if (options.listError) throw options.listError;
        return repos[record.name]!;
      };
    },
    activity: options.activity ?? { stale: () => true },
    observeTenant: observer.observe,
    headChecks: async () => options.headChecks ?? [],
    verdicts: { latest: async () => options.recorded ?? [] },
    store: store(),
    readCheckPack: async function readCheckPack(_tenantId, repo) {
      if (options.noPack) return { status: "missing" };
      return { status: "ok", pack: options.pack ?? { ...emptyPack(repo), checks: { "no-merge-conflicts": { enabled: true } } }, automatic: options.automatic ?? [], source: { repo: { id: "art_pack", version: 1 } } };
    },
    send: async function send({ payload }) {
      delivered.push({ payload: payload as Record<string, unknown> });
    },
    policy: triageReconcilePolicy({ ...(options.maxInFlight !== undefined && { TRIAGE_MAX_IN_FLIGHT: options.maxInFlight }) }),
    now,
    log: (entry) => logged.push(entry),
  });
  function store(): TriageStateStore {
    return {
      async load(_tenantId, repo) {
        return { rows: saved.get(repo) ?? [], version: { artifactId: `art_${repo}`, version: 1 } };
      },
      async save(_tenantId, repo, rows, expected) {
        if (refusals > 0) {
          refusals -= 1;
          options.onRefusedSave?.(repo);
          throw new TriageStateConflictError(repo);
        }
        saved.set(repo, rows);
        return expected;
      },
    };
  }
  function sweep(): void {
    const stopped = deployments.filter((live) => live.cancelling);
    for (const live of stopped) deployments.splice(deployments.indexOf(live), 1);
  }
  return { reconcile, listings, delivered, saved, logged, reads, latestOf, deployments, released, sweep, records, verdicts, approved, store: store() };
}

function settled(from: number, count: number): Record<string, WorkflowRunEvent[]> {
  const runs: Record<string, WorkflowRunEvent[]> = {};
  for (const { number } of heads(from, count)) runs[`run_${number}`] = [started(number), rendered(current(number)), completed];
  return runs;
}

function rotationLogs(logged: ReadonlyArray<Record<string, unknown>>): unknown[] {
  return logged.map((entry) => entry["msg"]).filter((msg) => String(msg).startsWith("triage_deployment_") || String(msg).startsWith("triage_rotation_"));
}

describe("triage reconciler", () => {
  test("a host without build webhooks: a head whose verdict waits on CI is queued again once its builds stop pending", async () => {
    const waiting = { ...current(1), repo: REPO, number: 1, state: "awaiting-review", actor: "system", humanGated: false, checks: [{ check: "ci-green", kind: "machine", result: "unconfirmed" }] };
    const logs: Logs = { [repoKey(LIVE.runId)]: { run_1: [started(1), rendered(waiting), completed] } };
    const pending = harness(logs, [head(1)], { headChecks: [{ name: "build", status: "in_progress", conclusion: null }] });
    await pending.reconcile();
    expect(pending.delivered).toHaveLength(0);
    const finished = harness(logs, [head(1)], { headChecks: [{ name: "build", status: "completed", conclusion: "success" }] });
    await finished.reconcile();
    expect(mailedNumbers(finished.delivered)).toEqual([1]);
    expect(finished.logged).toContainEqual(expect.objectContaining({ msg: "triage_requeued", pr: 1, reason: "build_status_changed" }));
    // A verdict that failed on CI is polled too: red turning green is caught without another event.
    const failed = { ...waiting, checks: [{ check: "ci-green", kind: "machine", result: "fail" }] };
    const red = { [repoKey(LIVE.runId)]: { run_1: [started(1), rendered(failed), completed] } };
    const stillRed = harness(red, [head(1)], { headChecks: [{ name: "build", status: "completed", conclusion: "failure" }] });
    await stillRed.reconcile();
    expect(stillRed.delivered).toHaveLength(0);
    const green = harness(red, [head(1)], { headChecks: [{ name: "build", status: "completed", conclusion: "success" }] });
    await green.reconcile();
    expect(mailedNumbers(green.delivered)).toEqual([1]);
  });

  test("a head whose verdict waits on CI is queued again once CI finished, though the deployment that gave the verdict was replaced", async () => {
    const triaged: PrTriageRow = { number: 1, headSha: "sha1", status: "triaged", attempts: 1, runId: "run_gone", firstSeenAt: LONG_AGO, updatedAt: LONG_AGO };
    const recorded: VerdictRecord = { tenantId: TENANT_ID, runId: "run_gone", repo: REPO, number: 1, headSha: "sha1", startedAt: new Date(LONG_AGO), verdictAt: new Date(LONG_AGO), settled: true, state: "awaiting-review", actor: "system", humanGated: false, degraded: null, checks: [{ check: "ci-green", result: "unconfirmed" }], dos: [], commented: false, detail: null, trigger: "pull_request:opened", runStatus: null };
    const run = harness({ [repoKey(LIVE.runId)]: {} }, [head(1)], { rows: [triaged], recorded: [recorded], headChecks: [{ name: "build", status: "completed", conclusion: "success" }] });
    await run.reconcile();
    expect(mailedNumbers(run.delivered)).toEqual([1]);
    expect(run.logged).toContainEqual(expect.objectContaining({ msg: "triage_requeued", pr: 1, reason: "build_status_changed" }));
  });

  test("a head the reconciler holds for CI is mailed to be marked waiting once, where triage writes labels", async () => {
    const pack = { ...emptyPack(REPO), checks: { "ci-green": { enabled: true } } };
    const run = harness({ [repoKey(LIVE.runId)]: {} }, [head(1)], { pack, automatic: ["labels"], headChecks: [{ name: "build", status: "in_progress", conclusion: null }] });
    await run.reconcile();
    await run.reconcile();
    expect(run.delivered.map((entry) => entry.payload)).toEqual([expect.objectContaining({ kind: "waiting", prNumber: 1, headSha: "sha1" })]);
  });

  test("a repository with every rule off, or no policy, starts no run and is logged once per head", async () => {
    const off = harness({ [repoKey(LIVE.runId)]: {} }, [head(1), head(2)], { pack: emptyPack(REPO) });
    await off.reconcile();
    expect(off.delivered).toHaveLength(0);
    await off.reconcile();
    expect(off.logged.filter((entry) => entry.msg === "triage_skipped_no_rules").map((entry) => entry.pulls)).toEqual([[1, 2]]);
    const unset = harness({ [repoKey(LIVE.runId)]: {} }, [head(1)], { noPack: true });
    await unset.reconcile();
    await unset.reconcile();
    expect(unset.delivered).toHaveLength(0);
    expect(unset.logged.filter((entry) => entry.msg === "triage_skipped_no_policy")).toEqual([expect.objectContaining({ pulls: [1] })]);
  });

  test("reads only the live deployment's runs and queues to it", async () => {
    const logs: Logs = {
      [repoKey("run_old")]: { run_old_pr: [started(1), rendered(current(1)), completed] },
      [repoKey(LIVE.runId)]: {},
    };
    const { reconcile, delivered, reads, latestOf } = harness(logs, [head(1)]);
    await reconcile();
    expect(latestOf.map(([repo]) => repo)).toEqual([repoKey(LIVE.runId)]);
    expect(reads.every((read) => read.repo === repoKey(LIVE.runId))).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ payload: { kind: "pr", repo: REPO, items: [{ prNumber: 1, headSha: "sha1" }] } });
  });

  test("the Dos a run executed are recorded on its verdict", async () => {
    const comment = { id: "hello", branch: "always", index: 0, kind: "comment", reason: "", effectId: "e-comment", target: { body: "hi" } };
    const label = { ...comment, index: 1, kind: "labels", effectId: "e-label", target: { labels: ["x"] } };
    const verdict = { ...current(1), repo: REPO, number: 1, state: "ready", actor: "maintainer", humanGated: false, actions: [comment, label] };
    const executed = replied("execute", { dos: [{ effectId: "e-comment", status: "done" }, { effectId: "e-label", status: "failed", error: "github POST -> 500" }] });
    const log = [started(1), rendered(verdict), executed, completed];
    const { reconcile, verdicts } = harness({ [repoKey(LIVE.runId)]: { run_1: log } }, [head(1)]);
    await reconcile();
    const outcomes = [{ effectId: "e-comment", status: "done" }, { effectId: "e-label", status: "failed", error: "github POST -> 500" }];
    expect(verdictFor(log, REPO, 1)?.["actions"]).toMatchObject(outcomes);
    expect(verdicts.at(-1)?.detail?.actions).toMatchObject(outcomes);
  });

  test("a held Do's approval run puts its outcome on the verdicts of its head, once", async () => {
    const held = { id: "hello", branch: "always", index: 0, kind: "comment", reason: "", effectId: "e-comment", target: { body: "hi" }, held: true };
    const verdict = { ...current(1), repo: REPO, number: 1, state: "ready", actor: "maintainer", humanGated: false, actions: [held] };
    const mail = stockTriggerMail({ kind: "approve-do", runId: "run_1", request: { repo: REPO, number: 1 } });
    const approval = [startedBy(mail, "2026-10-07T02:00:00.000Z"), replied("executeApproved", { dos: [{ effectId: "e-comment", status: "done" }] }), completed];
    const retriaged = [started(1, "2026-10-07T03:00:00.000Z"), rendered(verdict), completed];
    const { reconcile, verdicts, approved } = harness({ [repoKey(LIVE.runId)]: { run_1: [started(1), rendered(verdict), completed], run_2: approval, run_3: retriaged } }, [head(1)]);
    await reconcile();
    await reconcile();
    const latest = new Map(verdicts.map((recorded) => [recorded.runId, recorded]));
    expect([...latest.keys()].sort()).toEqual(["run_1", "run_3"]);
    for (const recorded of latest.values()) expect(recorded.detail?.actions).toMatchObject([{ effectId: "e-comment", held: true, status: "done" }]);
    expect(approved).toEqual([{ repo: REPO, number: 1, effectId: "e-comment", status: "done" }]);
  });

  test("a verdict is recorded with what the portal shows of it: its own fields, the facts it read and the webhook event that started it", async () => {
    const mail = stockTriggerMail({ kind: "pr", repo: REPO, prNumber: 1, headSha: "sha1", event: "pull_request", action: "synchronize" });
    const facts = { repo: REPO, number: 1, title: "Add widgets", author: "ann", draft: false, mergeable: true, checks: "success", body: "not shown" };
    const ruled: WorkflowRunEvent = { seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "rules", output: { ref: `inline:${JSON.stringify({ items: [{ facts, det: {} }] })}` } } };
    const check = { check: "ci-green", kind: "machine", result: "pass", reason: "green", evidence: [], gate: false };
    const verdict = { ...current(1), repo: REPO, number: 1, state: "ready-monitoring", actor: "author", humanGated: false, priority: "P2", feedback: "Thanks.", checks: [check], det: { sources: {} } };
    const { reconcile, verdicts } = harness({ [repoKey(LIVE.runId)]: { run_1: [startedBy(mail, "2026-10-07T01:00:00.000Z"), ruled, rendered(verdict), completed] } }, [head(1)]);
    await reconcile();
    expect(verdicts).toMatchObject([{
      runId: "run_1",
      trigger: "pull_request:synchronize",
      detail: { priority: "P2", feedback: "Thanks.", reason: "", checks: [check], facts: { title: "Add widgets", author: "ann", draft: false, mergeable: true, checks: "success" } },
    }]);
    expect(verdicts[0]!.detail).not.toHaveProperty("det");
    expect(verdicts[0]!.detail?.facts).not.toHaveProperty("body");
  });

  test("a verdict is recorded once its step completes, and kept when the run then fails", async () => {
    const verdict = { ...current(1), repo: REPO, number: 1, state: "ready-monitoring", actor: "author", humanGated: false };
    const log = [started(1), rendered(verdict)];
    const { reconcile, verdicts } = harness({ [repoKey(LIVE.runId)]: { run_1: log } }, [head(1)]);
    await reconcile();
    expect(verdicts.map(({ runId, state, settled, runStatus }) => ({ runId, state, settled, runStatus }))).toEqual([{ runId: "run_1", state: "ready-monitoring", settled: true, runStatus: "running" }]);
    log.push({ seq: 3, type: "RunFailed", body: { type: "RunFailed", seq: 3 } });
    await reconcile();
    expect(verdicts.map(({ runId, state, runStatus }) => ({ runId, state, runStatus }))).toEqual([
      { runId: "run_1", state: "ready-monitoring", runStatus: "running" },
      { runId: "run_1", state: "ready-monitoring", runStatus: "failed" },
    ]);
  });

  test("draft heads are not queued", async () => {
    const { reconcile, delivered } = harness({ [repoKey(LIVE.runId)]: {} }, [{ ...head(1), draft: true }, head(2)]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([2]);
  });

  test("a degraded verdict is queued again and a clean one settles the head", async () => {
    const logs: Logs = {
      [repoKey(LIVE.runId)]: {
        run_degraded: [started(2), rendered({ degraded: "error", reason: "This repository still needs a policy." }), completed],
        run_clean: [started(3), rendered(current(3)), completed],
      },
    };
    const { reconcile, delivered, saved } = harness(logs, [head(2), head(3)]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([2]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.find((row) => row.number === 2)).toMatchObject({ status: "queued", attempts: 1 });
    expect(rows.find((row) => row.number === 3)).toMatchObject({ status: "triaged", runId: "run_clean" });
  });

  test("verdicts on another commit or with unconfirmed checks are queued again with their reason", async () => {
    const unconfirmed = [{ check: "no-merge-conflicts", kind: "machine", result: "unconfirmed" }, { check: "docs", kind: "model", result: "unconfirmed" }];
    const logs: Logs = {
      [repoKey(LIVE.runId)]: {
        run_other_head: [started(2), rendered({ ...current(2), headSha: "sha2-pushed" }), completed],
        run_unconfirmed: [started(3), rendered({ ...current(3), checks: unconfirmed }), completed],
        run_not_asked: [started(4), rendered({ ...current(4), checks: [{ check: "docs", kind: "model", result: "unconfirmed" }] }), completed],
        run_ci_pending: [started(5), rendered({ ...current(5), checks: [{ check: "ci-green", kind: "machine", result: "unconfirmed" }, { check: "docs", kind: "model", result: "pass" }] }), completed],
      },
    };
    const { reconcile, delivered, saved, logged } = harness(logs, [head(2), head(3), head(4), head(5)]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([2, 3]);
    const reasons = logged.filter((entry) => entry["msg"] === "triage_requeued").map((entry) => entry["reason"]);
    expect(reasons).toEqual(["verdict made on head sha2-pushed", "unconfirmed checks: no-merge-conflicts"]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.filter((row) => row.number < 4).every((row) => row.status === "queued" && row.attempts === 1 && row.workflowVersion === VERSION)).toBe(true);
    expect(rows.find((row) => row.number === 4)).toMatchObject({ status: "triaged", runId: "run_not_asked", workflowVersion: VERSION });
    // Running checks settle; the completed check_run webhook triages the head again.
    expect(rows.find((row) => row.number === 5)).toMatchObject({ status: "triaged", runId: "run_ci_pending" });
  });

  test("a facts failure evaluates to a degraded verdict naming no head, which is queued again with the facts error", async () => {
    function unreachable(): never {
      throw new Error("facts read the host");
    }
    const read = await readFacts({ kind: "pr", repo: REPO, policy: { enabled: true }, checkPack: emptyPack(REPO) }, () => unreachable);
    const ctx = {} as never;
    const signal = new AbortController().signal;
    const verdict = await evaluate(await rules(read, ctx, signal), ctx, signal) as Record<string, unknown>;
    expect(verdict).toMatchObject({ degraded: "error", headSha: null, reason: "facts: pr input has no prNumber" });
    const logs: Logs = { [repoKey(LIVE.runId)]: { run_fail: [started(1), rendered(verdict), completed] } };
    const { reconcile, delivered, logged } = harness(logs, [head(1)]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1]);
    expect(logged.find((entry) => entry["msg"] === "triage_requeued")?.["reason"]).toBe("degraded: facts: pr input has no prNumber");
  });

  test("a merge triages the repository's other settled heads again, not the merged one or another repository's", async () => {
    const OTHER = "acme/gadgets";
    const runs: Record<string, WorkflowRunEvent[]> = {
      ...settled(1, 3),
      run_other: [startedBy(stockTriggerMail({ kind: "pr", repo: OTHER, prNumber: 4, headSha: "sha4" }), "2026-10-07T01:00:00.000Z"), rendered(current(4)), completed],
    };
    let now = NOW;
    const open = { [REPO]: heads(1, 3), [OTHER]: [head(4)] };
    const { reconcile, delivered, saved, logged, store } = harness({ [repoKey(LIVE.runId)]: runs }, open, { now: () => now });
    await reconcile();
    expect(delivered).toEqual([]);

    now = at(1);
    open[REPO] = [head(1), head(3)];
    expect(await markBaseMoved(store, TENANT_ID, REPO, 2, now, DEFAULT_RECONCILE_POLICY)).toBe(2);
    now = at(2);
    await reconcile();
    expect(mailedHeads(delivered)).toEqual([[REPO, 1], [REPO, 3]]);
    expect(logged.filter((entry) => entry["msg"] === "triage_requeued").map((entry) => entry["reason"])).toEqual(["base branch moved", "base branch moved"]);
    expect(saved.get(OTHER)?.[0]).toMatchObject({ status: "triaged" });

    runs["run_recheck"] = [startedBatch([1, 3], at(2).toISOString()), rendered({ items: [current(1), current(3)] }), completed];
    now = at(3);
    await reconcile();
    expect(saved.get(REPO)?.map((row) => [row.number, row.status, row.runId])).toEqual([[1, "triaged", "run_recheck"], [3, "triaged", "run_recheck"]]);
  });

  test("a head in flight when the base branch moves runs again once its run ends and its base move window has passed", async () => {
    const runs: Record<string, WorkflowRunEvent[]> = { run_1: [started(1, at(-1).toISOString())], run_3: [started(3), rendered(current(3)), completed] };
    let now = NOW;
    const { reconcile, delivered, saved, store } = harness({ [repoKey(LIVE.runId)]: runs }, [head(1), head(3)], { now: () => now });
    await reconcile();
    expect(saved.get(REPO)?.map((row) => row.status)).toEqual(["running", "triaged"]);

    now = at(1);
    expect(await markBaseMoved(store, TENANT_ID, REPO, 7, now, DEFAULT_RECONCILE_POLICY)).toBe(1);
    now = at(2);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([3]);
    expect(saved.get(REPO)?.map((row) => row.status)).toEqual(["running", "queued"]);

    // #3's run starts before a second merge and ends after it; #1's run outlives both.
    runs["run_3b"] = [started(3, at(2.5).toISOString())];
    now = at(4);
    expect(await markBaseMoved(store, TENANT_ID, REPO, 8, now, DEFAULT_RECONCILE_POLICY)).toBe(0);
    now = at(5);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([3]);
    expect(saved.get(REPO)?.map((row) => row.status)).toEqual(["running", "running"]);

    runs["run_1"]!.push(rendered(current(1)), completed);
    runs["run_3b"]!.push(rendered(current(3)), completed);
    now = at(6);
    await reconcile();
    // #1 was never queued by the hub, so it goes at once; #3, queued at minute 2, waits out its window.
    expect(mailedNumbers(delivered)).toEqual([3, 1]);

    runs["run_1b"] = [started(1, at(6).toISOString()), rendered(current(1)), completed];
    now = at(1 + BASE_MOVE_WINDOW);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([3, 1]);
    now = at(2 + BASE_MOVE_WINDOW);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([3, 1, 3]);

    runs["run_3c"] = [started(3, now.toISOString()), rendered(current(3)), completed];
    now = at(3 + BASE_MOVE_WINDOW);
    await reconcile();
    expect(saved.get(REPO)?.map((row) => [row.number, row.status, row.runId])).toEqual([[1, "triaged", "run_1b"], [3, "triaged", "run_3c"]]);
  });

  test("a merge re-checks a head that failed past its attempts, and counts only the heads it makes due", async () => {
    let now = NOW;
    const { reconcile, delivered, saved, store } = harness({}, [head(1), head(2)], { now: () => now });
    const capped: PrTriageRow = { number: 1, headSha: "sha1", status: "failed", attempts: DEFAULT_RECONCILE_POLICY.maxAttempts, error: "degraded: facts interrupted: abort", firstSeenAt: LONG_AGO, queuedAt: LONG_AGO, updatedAt: LONG_AGO };
    const backingOff: PrTriageRow = { ...capped, number: 2, headSha: "sha2", attempts: 1, queuedAt: NOW.toISOString() };
    saved.set(REPO, [capped, backingOff]);
    await reconcile();
    expect(delivered).toEqual([]);
    now = at(1);
    expect(await markBaseMoved(store, TENANT_ID, REPO, 9, now, DEFAULT_RECONCILE_POLICY)).toBe(1);
    now = at(2);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1]);
  });

  test("merges inside a head's base move window re-check it once when the window closes, not once per merge", async () => {
    const runs = settled(1, 2);
    let now = NOW;
    const { reconcile, delivered, store } = harness({ [repoKey(LIVE.runId)]: runs }, heads(1, 2), { now: () => now });
    await reconcile();
    now = at(1);
    await markBaseMoved(store, TENANT_ID, REPO, 9, now, DEFAULT_RECONCILE_POLICY);
    now = at(2);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2]);

    runs["run_recheck"] = [startedBatch([1, 2], at(2).toISOString()), rendered({ items: [current(1), current(2)] }), completed];
    for (const minute of [4, 6, 8, 10, 12]) {
      now = at(minute);
      await markBaseMoved(store, TENANT_ID, REPO, minute, now, DEFAULT_RECONCILE_POLICY);
      now = at(minute + 1);
      await reconcile();
    }
    expect(delivered).toHaveLength(2);
    now = at(2 + BASE_MOVE_WINDOW);
    await reconcile();
    expect(delivered).toHaveLength(4);
    expect(mailedNumbers(delivered)).toEqual([1, 2, 1, 2]);
  });

  test("a run after a base move settles its head though the sidecar clock trails the hub's by under the skew allowance", () => {
    const moved = NOW.getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    const row: PrTriageRow = { number: 7, headSha: "abc", status: "queued", attempts: 1, firstSeenAt: LONG_AGO, queuedAt: iso(moved + 50), staleBefore: iso(moved), updatedAt: iso(moved + 50) };
    const run: ObservedRun = { runId: "run_after", status: "completed", startedAt: iso(moved + 50 - 500) };
    const pr = { number: 7, headSha: "abc", updatedAt: LONG_AGO, draft: false };
    const plans = planTenant({ repos: [{ name: REPO, prs: [pr], rows: [row] }], runs: new Map([[REPO, new Map([["7@abc", [run]]])]]), now: at(1), policy: DEFAULT_RECONCILE_POLICY, workflowVersion: undefined });
    expect(plans.get(REPO)!.rows[0]!.status).toBe("triaged");
  });

  describe("judge answers", () => {
    const pack: CheckPack = { ...emptyPack(REPO), checks: { "no-merge-conflicts": { enabled: true }, focused: { enabled: true } } };
    const policy = { enabled: true, checkPack: { name: REPO } };

    async function remailed(related: number, deployments?: LiveDeployment[]) {
      const first = await triageMail(stockTriggerMail({ kind: "pr", repo: REPO, items: [1, 3].map((n) => ({ prNumber: n, headSha: `sha${n}` })), policy, checkPack: pack }), { mergeable: true }, related);
      const runs = { run_first: [startedBatch([1, 3]), evaluated({ items: first.verdicts }), completed] };
      const { reconcile, delivered, store } = harness({ [repoKey(LIVE.runId)]: runs }, [head(1), head(3)], { pack, ...(deployments && { deployments }) });
      await reconcile();
      await markBaseMoved(store, TENANT_ID, REPO, 2, NOW, DEFAULT_RECONCILE_POLICY);
      await reconcile();
      return { first, payload: delivered[0]!.payload };
    }

    test("a head re-checked after a merge reuses its decisive answers, while its conflicts are read afresh", async () => {
      const { first, payload } = await remailed(0.8);
      expect(first.asked).toBe(2);
      expect((payload["items"] as Array<{ judged?: object }>).map((item) => Object.keys(item.judged ?? {}).length)).toEqual([2]);
      const reused = await triageMail(stockTriggerMail(payload), { mergeable: true });
      expect(reused.asked).toBe(0);
      expect(reused.verdicts.map(({ verdict, checks }) => [verdict, checks.find((check) => check.check === "focused")?.result])).toEqual([["pass", "pass"]]);
      const conflicted = await triageMail(stockTriggerMail(payload), { mergeable: false });
      expect(conflicted.asked).toBe(0);
      expect(conflicted.verdicts.map(({ verdict, checks }) => [verdict, checks.find((check) => check.check === "no-merge-conflicts")?.result])).toEqual([["fail", "fail"]]);
    });

    test("answers ride only on mail whose From is the hub's bare address on the deployment's domain", async () => {
      const { payload } = await remailed(0.8);
      const hub = createEd25519Crypto(await generateKeyPair());
      const hubSender = `github@${DOMAIN}`;
      let raw: Uint8Array | undefined;
      const trigger = createRunTriggerDeliverer({
        materialize: async () => ({ outcome: "materialized" as const, stepGrants: [] }),
        router: {
          async routeMail(_address: string, base64: string) {
            raw = Buffer.from(base64, "base64");
            return true;
          },
        },
        tenantDomain: async () => DOMAIN,
        senderLocalPart: "github",
        systemSender: { resolve: async () => ({ address: hubSender, publicKey: Buffer.from(hub.getPublicKey()).toString("hex"), sign: (input: Uint8Array) => hub.sign(input) }) },
      });
      await trigger.to(LIVE.address, JSON.stringify(payload), TENANT_ID, undefined);
      const { headers, rawHeaders, parts } = decodeMail(raw!);
      const fromHub = { headers, rawHeaders, parts: parts.map((part, i) => ({ contentType: part.contentType, ref: `mail-part:///run_x/m1/${i}`, text: new TextDecoder().decode(part.content) })) };
      expect((await triageMail(fromHub, { mergeable: true })).asked).toBe(0);

      // Stock binds a mail to its authenticated sender by the address `extractAddrSpec` reads, so this From passes its gate for another run.
      const memberRun = formatRunAddress("run_member", DOMAIN);
      const named = `"<${hubSender}>" <${memberRun}>`;
      expect(extractAddrSpec(named)).toBe(memberRun);
      for (const from of [named, "github@other.test"]) {
        const mail = stockTriggerMail(payload);
        const forged = { ...mail, headers: { ...mail.headers, from }, rawHeaders: { ...mail.rawHeaders, from: [from] } };
        expect((await triageMail(forged, { mergeable: true })).asked).toBe(1);
      }
    });

    test("unsure answers are not carried", async () => {
      const { first, payload } = await remailed(0.5);
      expect(first.verdicts.every((verdict) => verdict.judged === undefined)).toBe(true);
      expect((payload["items"] as Array<{ judged?: object }>).every((item) => item.judged === undefined)).toBe(true);
    });

    test("answers are not carried to a deployment on another decision-model offering", async () => {
      const { payload } = await remailed(0.8, [{ ...deployment("run_new", NOW), offeringId: "off_other" }, LIVE]);
      expect((payload["items"] as Array<{ judged?: object }>).every((item) => item.judged === undefined)).toBe(true);
    });
  });

  test("heads settled under another workflow version than the live deployment's, a legacy integer included, keep their verdicts", async () => {
    const { reconcile, delivered, saved } = harness({}, [head(1), head(2)]);
    const settled = (number: number, workflowVersion: string | number): PrTriageRow => ({ number, headSha: `sha${number}`, status: "triaged", attempts: 0, runId: `old_${number}`, workflowVersion, firstSeenAt: LONG_AGO, updatedAt: LONG_AGO });
    const rows = [settled(1, 3), settled(2, "0.1.0-sha-00000000")];
    saved.set(REPO, rows);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([]);
    expect(saved.get(REPO)).toEqual(rows);
  });

  test("a finished run's log is read once and then left out of later passes", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: { run_clean: [started(3), rendered(current(3)), completed] } };
    const { reconcile, reads, latestOf } = harness(logs, [head(3)]);
    await reconcile();
    await reconcile();
    expect(reads).toHaveLength(1);
    expect(latestOf[1]).toEqual([repoKey(LIVE.runId)]);
  });

  test("the in-flight budget is per tenant across repositories, oldest pull requests first", async () => {
    const { reconcile, delivered } = harness({}, { "acme/one": heads(1, 3), "acme/two": heads(100, 3) });
    await reconcile();
    expect(mailedHeads(delivered)).toEqual([["acme/one", 1], ["acme/one", 2], ["acme/one", 3], ["acme/two", 100], ["acme/two", 101]]);
  });

  test("TRIAGE_MAX_IN_FLIGHT caps the heads queued per pass", async () => {
    const { reconcile, delivered } = harness({}, heads(1, 5), { maxInFlight: "2" });
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2]);
  });

  test("each head is its own job, keyed by that head", async () => {
    const { reconcile, delivered } = harness({}, heads(1, 3));
    await reconcile();
    expect(delivered.map((entry) => mailedNumbers([entry]))).toEqual([[1], [2], [3]]);
  });

  test("a batch run's verdicts settle each head it named; a batch degraded before rendering queues every head again", async () => {
    const logs: Logs = {
      [repoKey(LIVE.runId)]: {
        run_batch: [startedBatch([1, 2, 3]), rendered({ items: [current(1), { ...current(2), headSha: "sha2-pushed" }, current(3)], summary: {} }), completed],
        run_failed: [startedBatch([4, 5]), rendered({ degraded: "error", reason: "facts interrupted: abort", headSha: null }), completed],
      },
    };
    const { reconcile, delivered, saved, logged } = harness(logs, heads(1, 5));
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([2, 4, 5]);
    expect(logged.filter((entry) => entry["msg"] === "triage_requeued").map((entry) => entry["reason"])).toEqual(["verdict made on head sha2-pushed", "degraded: facts interrupted: abort", "degraded: facts interrupted: abort"]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.filter((row) => row.status === "triaged").map((row) => [row.number, row.runId])).toEqual([[1, "run_batch"], [3, "run_batch"]]);
    expect(rows.filter((row) => row.status === "queued").map((row) => row.number)).toEqual([2, 4, 5]);
  });

  test("queued heads that have not started hold the budget until their runs complete", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: {} };
    const { reconcile, delivered, saved } = harness(logs, heads(1, 12));
    await reconcile();
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2, 3, 4, 5]);
    // Only a run started since the hub queued the head settles it.
    for (const number of [1, 2, 3, 4, 5]) logs[repoKey(LIVE.runId)]![`run_${number}`] = [started(number, "2026-10-07T12:00:30.000Z"), rendered(current(number)), completed];
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.filter((row) => row.status === "triaged").map((row) => row.number)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.filter((row) => row.status === "new").map((row) => row.number)).toEqual([11, 12]);
  });

  test("a state write refused as stale is retried once on the other writer's rows, keeping the newer row of each head", async () => {
    const { reconcile, delivered, saved, logged } = harness({}, [head(1), head(2)], {
      refuseSaves: 1,
      onRefusedSave: (repo) => saved.set(repo, [{ number: 1, headSha: "sha1", status: "queued", attempts: 3, firstSeenAt: LONG_AGO, queuedAt: "2026-10-07T12:00:30.000Z", updatedAt: "2026-10-07T12:00:30.000Z" }]),
    });
    await reconcile();
    const rows = saved.get(REPO) ?? [];
    expect(rows.map((row) => `${row.number}:${row.status}:${row.attempts}`)).toEqual(["1:queued:3", "2:queued:1"]);
    expect(mailedNumbers(delivered)).toEqual([2]);
    expect(logged).toContainEqual(expect.objectContaining({ msg: "triage_state_merged", repo: REPO, left: 1 }));
    const twice = harness({}, [head(1)], { refuseSaves: 2 });
    await twice.reconcile();
    expect(twice.saved.get(REPO)).toBeUndefined();
    expect(twice.delivered).toEqual([]);
    expect(twice.logged).toContainEqual(expect.objectContaining({ msg: "triage_state_conflict", repo: REPO }));
  });

  test("a run triggered by the stock mail, decoded or stringified, is seen running and settles on its verdict", async () => {
    const at = "2026-10-07T12:00:30.000Z";
    const runs: Record<string, WorkflowRunEvent[]> = {};
    const { reconcile, delivered, saved } = harness({ [repoKey(LIVE.runId)]: runs }, [head(1), head(2)]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2]);
    runs["run_mail"] = [startedBy(stockTriggerMail({ kind: "pr", repo: REPO, items: [{ prNumber: 1, headSha: "sha1" }] }), at)];
    runs["run_string"] = [startedBy(JSON.stringify(stockTriggerMail({ kind: "pr", repo: REPO, items: [{ prNumber: 2, headSha: "sha2" }] })), at)];
    await reconcile();
    expect(saved.get(REPO)!.map((row) => [row.number, row.status, row.runId])).toEqual([[1, "running", "run_mail"], [2, "running", "run_string"]]);
    runs["run_mail"]!.push(rendered({ items: [current(1)] }), completed);
    runs["run_string"]!.push(rendered({ items: [current(2)] }), completed);
    await reconcile();
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2]);
    expect(saved.get(REPO)!.map((row) => [row.number, row.status, row.runId])).toEqual([[1, "triaged", "run_mail"], [2, "triaged", "run_string"]]);
  });

  test("a head still running holds one of the tenant's slots", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: { run_going: [started(1, "2026-10-07T11:55:00.000Z")] } };
    const { reconcile, delivered } = harness(logs, heads(1, 7));
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([2, 3, 4, 5]);
  });

  test("heads first seen together queue lowest pull request number first, whatever order GitHub lists them", async () => {
    const { reconcile, delivered } = harness({}, heads(1, 10).reverse());
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a deployment past its run threshold is replaced once before the pass mails, and released once after its running head settles", async () => {
    const live = { ...settled(1, 19), run_going: [started(20, "2026-10-07T11:55:00.000Z")] };
    const logs: Logs = { [repoKey(LIVE.runId)]: live };
    let clock = NOW;
    const { reconcile, delivered, saved, deployments, released, logged, sweep, records } = harness(logs, [head(20), head(21)], { rotateAfterRuns: 19, now: () => clock });
    await reconcile();
    expect(deployments.map((live) => live.runId)).toEqual(["run_live_fresh", LIVE.runId]);
    expect(records.rotation).toEqual({ from: LIVE.runId, to: "run_live_fresh", at: NOW.toISOString() });
    const fresh = deployments[0]!;
    expect(mailedNumbers(delivered)).toEqual([21]);

    await reconcile();
    expect(released).toEqual([]);

    live["run_going"] = [started(20, "2026-10-07T11:55:00.000Z"), rendered(current(20)), completed];
    clock = new Date(NOW.getTime() + DEFAULT_RECONCILE_POLICY.unstartedAfterMs);
    await reconcile();
    await reconcile();
    expect(released).toEqual([LIVE.runId]);
    expect(saved.get(REPO)!.find((row) => row.number === 20)).toMatchObject({ status: "triaged", runId: "run_going" });
    expect(delivered).toHaveLength(1);
    expect(rotationLogs(logged)).toEqual(["triage_deployment_rotated", "triage_deployment_released"]);

    sweep();
    await reconcile();
    expect(records.rotation).toBeUndefined();
    await reconcile();
    expect(deployments.map((live) => live.runId)).toEqual([fresh.runId]);
    expect(rotationLogs(logged)).toHaveLength(2);
  });

  test("a busy deployment is not replaced while another is live, and one no rotation names is never released", async () => {
    const fresh = deployment("run_fresh", new Date(NOW.getTime() - 2 * DEFAULT_RECONCILE_POLICY.stuckAfterMs));
    const logs: Logs = { [repoKey(fresh.runId)]: settled(1, 20), [repoKey(LIVE.runId)]: settled(30, 1) };
    const { reconcile, deployments, logged, released } = harness(logs, [], { rotateAfterRuns: 15, deployments: [fresh, LIVE] });
    await reconcile();
    expect(deployments.map((live) => live.runId)).toEqual([fresh.runId, LIVE.runId]);
    expect(released).toEqual([]);
    expect(rotationLogs(logged)).toEqual([]);
  });

  test("a replaced deployment is kept while a head still runs there or its copy is younger than the unstarted grace, and released once a head there is stuck", async () => {
    const record = (to: LiveDeployment): RotationRecord => ({ from: LIVE.runId, to: to.runId, at: LONG_AGO });
    const running = { [repoKey(LIVE.runId)]: { run_going: [started(30, "2026-10-07T11:55:00.000Z")] } };
    const settledAgo = deployment("run_fresh", new Date(NOW.getTime() - 2 * DEFAULT_RECONCILE_POLICY.unstartedAfterMs));
    const stillRunning = harness(running, [], { deployments: [settledAgo, LIVE], rotation: record(settledAgo) });
    await stillRunning.reconcile();
    expect(stillRunning.released).toEqual([]);

    const young = deployment("run_fresh", new Date(NOW.getTime() - MINUTE));
    const tooYoung = harness({ [repoKey(LIVE.runId)]: settled(1, 3) }, [], { deployments: [young, LIVE], rotation: record(young) });
    await tooYoung.reconcile();
    expect(tooYoung.released).toEqual([]);

    const stuckLogs = { [repoKey(LIVE.runId)]: { run_stuck: [started(30)] } };
    const longAgo = deployment("run_fresh", new Date(NOW.getTime() - DEFAULT_RECONCILE_POLICY.stuckAfterMs - MINUTE));
    const stuck = harness(stuckLogs, [], { deployments: [longAgo, LIVE], rotation: record(longAgo) });
    await stuck.reconcile();
    await stuck.reconcile();
    expect(stuck.released).toEqual([LIVE.runId]);
    expect(rotationLogs(stuck.logged)).toEqual(["triage_deployment_released"]);
  });

  test("two live deployments of the same source with no rotation recorded retire the older one; of different sources, neither", async () => {
    const newer = deployment("run_newer", new Date(NOW.getTime() - 2 * DEFAULT_RECONCILE_POLICY.unstartedAfterMs));
    const logs: Logs = { [repoKey(LIVE.runId)]: settled(1, 3) };
    const same = harness(logs, [head(20)], { deployments: [newer, LIVE], sameSource: true });
    await same.reconcile();
    expect(same.records.rotation).toEqual({ from: LIVE.runId, to: newer.runId, at: NOW.toISOString() });
    expect(same.released).toEqual([LIVE.runId]);

    const other = harness(logs, [head(20)], { deployments: [newer, LIVE] });
    await other.reconcile();
    expect(other.records.rotation).toBeUndefined();
    expect(other.released).toEqual([]);
  });

  test("a deployment made while a pass runs is not overtaken by a copy of the one it replaced", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: settled(1, 19) };
    const portal = deployment("run_portal_v2", new Date(NOW.getTime() + 1));
    let deployed = false;
    let state: ReturnType<typeof harness> | undefined;
    function now(): Date {
      // The portal deploys a new workflow version and cancels the old one while this pass runs.
      if (state && !deployed) {
        deployed = true;
        state.deployments.unshift(portal);
        state.deployments.splice(state.deployments.findIndex((live) => live.runId === LIVE.runId), 1);
      }
      return NOW;
    }
    state = harness(logs, [head(20)], { rotateAfterRuns: 15, now });
    await state.reconcile();
    expect(state.deployments.map((live) => live.runId)).toEqual([portal.runId]);
  });

  test("a copy that finished deploying after another deployment landed is released", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: settled(1, 19) };
    const portal = deployment("run_portal_v2", NOW);
    const { reconcile, deployments, delivered, released, records } = harness(logs, [head(20)], {
      rotateAfterRuns: 15,
      whileRedeploying: (live) => live.unshift({ ...portal }),
    });
    await reconcile();
    expect(released).toEqual(["run_live_fresh"]);
    expect(records.rotation).toBeUndefined();
    expect(deployments.map((live) => [live.runId, live.cancelling])).toEqual([["run_live_fresh", true], [portal.runId, false], [LIVE.runId, false]]);
  });

  test("a copy that outlived a failed post-deploy check never overtakes the user's newer deployment", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: settled(1, 19) };
    const portal = deployment("run_portal_v2", new Date(NOW.getTime() - 1));
    let clock = NOW;
    const state = harness(logs, [head(20)], {
      rotateAfterRuns: 15,
      now: () => clock,
      whileRedeploying(live) {
        // The user's new version lands while the copy probes; the copy's row is inserted later, so it is newer.
        live.unshift({ ...portal });
        failNextList = true;
      },
    });
    await state.reconcile();
    expect(state.logged.some((entry) => entry["msg"] === "triage_rotation_failed")).toBe(true);
    expect(state.deployments.map((live) => [live.runId, live.cancelling])).toEqual([["run_live_fresh", false], [portal.runId, false], [LIVE.runId, false]]);
    clock = new Date(NOW.getTime() + DEFAULT_RECONCILE_POLICY.unstartedAfterMs);
    await state.reconcile();
    expect(state.released).toEqual(["run_live_fresh"]);
    expect(state.records.rotation).toBeUndefined();
    await state.reconcile();
    expect(state.released).toEqual(["run_live_fresh"]);
  });

  test("a tenant without a GitHub credential is skipped with a reason", async () => {
    const { reconcile, delivered, logged } = harness({}, [head(1)], { github: false });
    await reconcile();
    expect(delivered).toEqual([]);
    expect(logged).toContainEqual(expect.objectContaining({ msg: "triage_reconcile_skipped", reason: "no_source_credential" }));
  });

  test("a repository is listed again once a webhook named it or half an hour passed, and every pass while its webhook heard nothing that long", async () => {
    let clock = NOW;
    const activity = createRepoActivity(() => clock, { quietMs: 30 * MINUTE, graceMs: MINUTE });
    const { reconcile, listings } = harness({ [repoKey(LIVE.runId)]: settled(1, 1) }, { [REPO]: [head(1)], "acme/gadgets": [] }, { now: () => clock, activity });
    function hear(minutes: number, repo: string): void {
      clock = at(minutes);
      activity.heard(TENANT_ID, "github", repo);
    }
    async function pass(minutes: number): Promise<string[]> {
      clock = at(minutes);
      listings.length = 0;
      await reconcile();
      return [...listings];
    }
    expect(await pass(0)).toEqual([REPO, "acme/gadgets"]);
    hear(2, REPO);
    hear(2, "acme/gadgets");
    // A listing that started within a minute of the delivery may not show it yet, so it is read once more.
    expect(await pass(2)).toEqual([REPO, "acme/gadgets"]);
    expect(await pass(5)).toEqual([REPO, "acme/gadgets"]);
    expect(await pass(10)).toEqual([]);
    hear(12, REPO);
    expect(await pass(15)).toEqual([REPO]);
    expect(await pass(20)).toEqual([]);
    // Half an hour after its last listing a repository is listed again, in case a delivery for it was lost.
    expect(await pass(35)).toEqual(["acme/gadgets"]);
    // The App's webhook heard nothing for half an hour: it may be broken, so every pass lists every repository as before.
    expect(await pass(42)).toEqual([REPO, "acme/gadgets"]);
    expect(await pass(47)).toEqual([REPO, "acme/gadgets"]);
    // A Bitbucket webhook is each repository's own, so one repository's delivery says nothing of another's.
    clock = at(50);
    activity.heard(TENANT_ID, "bitbucket-datacenter", "PROJ/one");
    clock = at(55);
    expect(activity.stale(TENANT_ID, "bitbucket-datacenter", "PROJ/one", at(52).getTime())).toBe(false);
    expect(activity.stale(TENANT_ID, "bitbucket-datacenter", "PROJ/two", at(52).getTime())).toBe(true);
  });

  test("a repository's kept listing is dropped once the tenant's reader cannot be built, so the next pass reads again", async () => {
    let clock = NOW;
    const activity = createRepoActivity(() => clock, { quietMs: 30 * MINUTE, graceMs: MINUTE });
    const options = { now: () => clock, activity, github: true };
    const { reconcile, listings } = harness({ [repoKey(LIVE.runId)]: settled(1, 1) }, [head(1)], options);
    activity.heard(TENANT_ID, "github", REPO);
    clock = at(2);
    await reconcile();
    options.github = false;
    clock = at(5);
    await reconcile();
    options.github = true;
    clock = at(10);
    await reconcile();
    expect(listings).toEqual([REPO, REPO]);
  });

  test("a listing GitHub rate limited is not kept, and the pass waits for the limit's reset", async () => {
    let clock = NOW;
    const activity = createRepoActivity(() => clock, { quietMs: 30 * MINUTE, graceMs: MINUTE });
    const options: HarnessOptions = { now: () => clock, activity };
    const { reconcile, listings } = harness({ [repoKey(LIVE.runId)]: settled(1, 1) }, [head(1)], options);
    activity.heard(TENANT_ID, "github", REPO);
    clock = at(25);
    await reconcile();
    // The App's webhook went quiet, so the listing is read again, and GitHub refuses it.
    clock = at(31);
    options.listError = new GithubRateLimited("1", at(33).getTime());
    expect(await reconcile()).toEqual(expect.objectContaining({ retryAt: at(33).getTime() }));
    options.listError = undefined;
    clock = at(32);
    activity.heard(TENANT_ID, "github", "acme/gadgets");
    clock = at(33);
    await reconcile();
    expect(listings).toEqual([REPO, REPO, REPO]);
  });
});
