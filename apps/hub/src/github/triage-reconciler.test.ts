import { describe, expect, test } from "bun:test";
import { formatRunAddress } from "@intx/types";
import { workflowRunRepoIdForAddress, type RepoId, type WorkflowRunEvent, type WorkflowRunReader } from "@intx/hub-sessions";
import { emptyPack, stockTriggerMail, type PrTriageRow } from "@corbits/triage-contracts";
import { DEFAULT_RECONCILE_POLICY, type OpenPr } from "./reconcile-plan.js";
import { triageReconcilePolicy } from "../env.js";
import { TriageStateConflictError } from "./triage-state-store.js";
import { createRunTriggerDeliverer, type RunTriggerMaterialize } from "@corbits/webhooks";
import { readyMaterializer, type LiveDeployment } from "./deployment.js";
import type { RotationRecord } from "./tenant-config.js";
import { createTriageReconciler } from "./triage-reconciler.js";
import { createTriageRuns } from "./triage-runs.js";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState } from "@intx/types/runtime";
import { triageDirectorFactory } from "../../../../packages/triage-workflows/src/directors.js";
import { evaluate, rules } from "../../../../packages/triage-workflows/src/actions/index.js";

const REPO = "acme/widgets";
const DOMAIN = "acme.test";
const TENANT_ID = "tnt_acme";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const LONG_AGO = "2026-10-07T00:00:00.000Z";
const VERSION = "0.1.0-sha-11111111";
const LIVE = deployment("run_live", new Date(LONG_AGO));
const MINUTE = 60_000;
let failNextList = false;

function deployment(runId: string, createdAt: Date): LiveDeployment {
  return { runId, address: formatRunAddress(runId, DOMAIN), createdAt, cancelling: false, workflowVersion: VERSION };
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

function rendered(verdict: Record<string, unknown>): WorkflowRunEvent {
  const output = { ref: `inline:${JSON.stringify({ reply: JSON.stringify(verdict), turn: 1 })}` };
  return { seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "render", output } };
}

const completed: WorkflowRunEvent = { seq: 2, type: "RunCompleted", body: { type: "RunCompleted", seq: 2 } };

type Logs = Record<string, Record<string, WorkflowRunEvent[]>>;
type Delivered = Array<{ address: string; payload: Record<string, unknown> }>;

function mailedHeads(delivered: Delivered): Array<[string, number]> {
  return delivered.flatMap((entry) => (entry.payload["items"] as Array<{ prNumber: number }>).map((item): [string, number] => [entry.payload["repo"] as string, item.prNumber]));
}

function mailedNumbers(delivered: Delivered): number[] {
  return mailedHeads(delivered).map(([, number]) => number);
}

/** Drives one real triage director for one inbound event and returns its reply. */
async function directorReply(role: "facts", event: ReactorInboundEvent): Promise<string> {
  const replies: string[] = [];
  const caps = {
    executeTools(calls: unknown) {
      return { type: "execute_tools", calls };
    },
    reply(content: string) {
      replies.push(content);
      return { type: "reply", content };
    },
  } as unknown as ReactorCapabilities;
  const director = triageDirectorFactory({ role }, {} as never, { systemPrompt: "" } as never);
  await director.decide(event, {} as ReactorState, caps);
  return replies[0]!;
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

/** `prs` is the open heads of REPO, or the open heads of several repositories by name. */
type HarnessOptions = {
  github?: boolean;
  batchSize?: number;
  /** The `TRIAGE_MAX_IN_FLIGHT` setting; unset keeps the default. */
  maxInFlight?: string;
  failDeliveryAt?: number;
  /** Stands in for the mail delivery; recorded only when it resolves. */
  deliver?: (tenantId: string, address: string, payload: unknown) => Promise<void>;
  refuseSaves?: number;
  onRefusedSave?: (repo: string) => void;
  onSave?: (repo: string, rows: PrTriageRow[]) => void;
  rotateAfterRuns?: number;
  now?: () => Date;
  /** Live deployments, newest first; LIVE alone by default. */
  deployments?: LiveDeployment[];
  /** Runs while the copy deploys, before it is listed. */
  whileRedeploying?: (deployments: LiveDeployment[]) => void;
  /** The rotation recorded in the tenant config; none by default. */
  rotation?: RotationRecord;
  /** Whether any two deployments run the same workflow source; false by default. */
  sameSource?: boolean;
  /** The repositories' triage-drafts setting; unset keeps the default. */
  triageDrafts?: boolean;
};

function harness(logs: Logs, prs: OpenPr[] | Record<string, OpenPr[]>, options: HarnessOptions = {}) {
  const repos = Array.isArray(prs) ? { [REPO]: prs } : prs;
  const records = { rotation: options.rotation };
  function tenant() {
    const ns = { repos: Object.keys(repos).map((name) => ({ name, connected: true, enabled: true, ...(options.triageDrafts !== undefined && { triageDrafts: options.triageDrafts }) })), ...(records.rotation && { rotation: records.rotation }) };
    return { id: TENANT_ID, domain: DOMAIN, config: { corbitsTriage: ns } };
  }
  const { reader, reads, latestOf } = fakeReader(logs);
  const delivered: Delivered = [];
  const saved = new Map<string, PrTriageRow[]>();
  let refusals = options.refuseSaves ?? 0;
  const logged: Array<Record<string, unknown>> = [];
  const now = options.now ?? (() => NOW);
  const deployments = (options.deployments ?? [LIVE]).map((live) => ({ ...live }));
  const released: string[] = [];
  const reconcile = createTriageReconciler({
    tenants: async function tenants() {
      return [tenant()];
    },
    liveDeployments: async function liveDeployments() {
      if (failNextList) {
        failNextList = false;
        throw new Error("transient list failure");
      }
      return deployments.map((live) => ({ ...live }));
    },
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
        return repos[record.name]!;
      };
    },
    observeRuns: createTriageRuns({ runReader: reader, readSettled: async () => new Map(), maxKnownRuns: 100 }),
    store: {
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
        options.onSave?.(repo, rows);
        return expected;
      },
    },
    readCheckPack: async function readCheckPack(_tenantId, repo) {
      return { status: "ok", pack: emptyPack(repo) };
    },
    deliver: async function deliver(tenantId, address, payload) {
      if (delivered.length === options.failDeliveryAt) throw new Error("unroutable");
      await options.deliver?.(tenantId, address, payload);
      delivered.push({ address, payload: payload as Record<string, unknown> });
    },
    policy: triageReconcilePolicy({ ...(options.maxInFlight !== undefined && { TRIAGE_MAX_IN_FLIGHT: options.maxInFlight }) }),
    batchSize: options.batchSize ?? DEFAULT_RECONCILE_POLICY.maxInFlight,
    now,
    log: (entry) => logged.push(entry),
  });
  function sweep(): void {
    const stopped = deployments.filter((live) => live.cancelling);
    for (const live of stopped) deployments.splice(deployments.indexOf(live), 1);
  }
  return { reconcile, delivered, saved, logged, reads, latestOf, deployments, released, sweep, records };
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
    expect(delivered[0]).toMatchObject({ address: LIVE.address, payload: { kind: "pr", repo: REPO, items: [{ prNumber: 1, headSha: "sha1" }] } });
  });

  test("draft heads are queued only while the repository triages drafts", async () => {
    const prs = [{ ...head(1), draft: true }, head(2)];
    const off = harness({ [repoKey(LIVE.runId)]: {} }, prs, { triageDrafts: false });
    await off.reconcile();
    expect(mailedNumbers(off.delivered)).toEqual([2]);
    const on = harness({ [repoKey(LIVE.runId)]: {} }, prs);
    await on.reconcile();
    expect(mailedNumbers(on.delivered)).toEqual([1, 2]);
  });

  test("a degraded verdict is queued again and a clean one settles the head", async () => {
    const logs: Logs = {
      [repoKey(LIVE.runId)]: {
        run_degraded: [started(2), rendered({ degraded: "error", reason: "This repository still needs check setup." }), completed],
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
    const unconfirmed = [{ check: "conflicts", kind: "machine", result: "unconfirmed" }, { check: "tests", kind: "model", result: "unconfirmed" }];
    const logs: Logs = {
      [repoKey(LIVE.runId)]: {
        run_other_head: [started(2), rendered({ ...current(2), headSha: "sha2-pushed" }), completed],
        run_unconfirmed: [started(3), rendered({ ...current(3), checks: unconfirmed }), completed],
        run_not_asked: [started(4), rendered({ ...current(4), checks: [{ check: "tests", kind: "model", result: "unconfirmed" }] }), completed],
      },
    };
    const { reconcile, delivered, saved, logged } = harness(logs, [head(2), head(3), head(4)]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([2, 3]);
    const reasons = logged.filter((entry) => entry["msg"] === "triage_requeued").map((entry) => entry["reason"]);
    expect(reasons).toEqual(["verdict made on head sha2-pushed", "unconfirmed checks: conflicts"]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.filter((row) => row.number !== 4).every((row) => row.status === "queued" && row.attempts === 1 && row.workflowVersion === VERSION)).toBe(true);
    expect(rows.find((row) => row.number === 4)).toMatchObject({ status: "triaged", runId: "run_not_asked", workflowVersion: VERSION });
  });

  test("a facts failure evaluates to a degraded verdict naming no head, which is queued again with the facts error", async () => {
    const reply = await directorReply("facts", { type: "abort" } as ReactorInboundEvent);
    const ctx = {} as never;
    const signal = new AbortController().signal;
    const verdict = await evaluate(await rules({ reply }, ctx, signal), ctx, signal) as Record<string, unknown>;
    expect(verdict).toMatchObject({ degraded: "error", headSha: null, reason: "facts interrupted: abort" });
    const logs: Logs = { [repoKey(LIVE.runId)]: { run_fail: [started(1), rendered(verdict), completed] } };
    const { reconcile, delivered, logged } = harness(logs, [head(1)]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1]);
    expect(logged.find((entry) => entry["msg"] === "triage_requeued")?.["reason"]).toBe("degraded: facts interrupted: abort");
  });

  test("heads settled under another workflow version than the live deployment's, a legacy integer included, are queued again", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: { run_current: [started(9), rendered(current(9)), completed] } };
    const { reconcile, delivered, saved, logged } = harness(logs, [head(1), head(2), head(9)]);
    const settled = (number: number, workflowVersion: string | number): PrTriageRow => ({ number, headSha: `sha${number}`, status: "triaged", attempts: 0, runId: `old_${number}`, workflowVersion, firstSeenAt: LONG_AGO, updatedAt: LONG_AGO });
    saved.set(REPO, [settled(1, 3), settled(2, "0.1.0-sha-00000000")]);
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2]);
    expect(logged.filter((entry) => entry["msg"] === "triage_requeued").map((entry) => entry["reason"])).toEqual([
      `verdict from workflow version 3, current is ${VERSION}`,
      `verdict from workflow version 0.1.0-sha-00000000, current is ${VERSION}`,
    ]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.filter((row) => row.number !== 9).every((row) => row.status === "queued" && row.attempts === 1 && row.workflowVersion === VERSION)).toBe(true);
    expect(rows.find((row) => row.number === 9)).toMatchObject({ status: "triaged", runId: "run_current", workflowVersion: VERSION });
  });

  test("a finished run's log is read once and then left out of later passes", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: { run_clean: [started(3), rendered(current(3)), completed] } };
    const { reconcile, reads, latestOf } = harness(logs, [head(3)]);
    await reconcile();
    await reconcile();
    expect(reads).toHaveLength(1);
    expect(latestOf[1]).toEqual([repoKey(LIVE.runId)]);
  });

  test("the in-flight budget is per tenant across repositories, oldest pull requests first, one mail per repository", async () => {
    const { reconcile, delivered } = harness({}, { "acme/one": heads(1, 3), "acme/two": heads(100, 3) });
    await reconcile();
    expect(delivered.map((entry) => entry.payload["repo"])).toEqual(["acme/one", "acme/two"]);
    expect(mailedHeads(delivered)).toEqual([["acme/one", 1], ["acme/one", 2], ["acme/one", 3], ["acme/two", 100], ["acme/two", 101]]);
  });

  test("TRIAGE_MAX_IN_FLIGHT caps the heads queued per pass", async () => {
    const { reconcile, delivered } = harness({}, heads(1, 5), { maxInFlight: "2" });
    await reconcile();
    expect(mailedNumbers(delivered)).toEqual([1, 2]);
  });

  test("a repository's heads are mailed in batches of at most the batch size", async () => {
    const { reconcile, delivered } = harness({}, heads(1, 5), { batchSize: 2 });
    await reconcile();
    expect(delivered.map((entry) => mailedNumbers([entry]))).toEqual([[1, 2], [3, 4], [5]]);
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
    expect(delivered).toHaveLength(1);
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

  test("queued heads are written before the mail goes out, and the heads of a mail that fails are put back", async () => {
    const saves: string[][] = [];
    const { reconcile, delivered, saved } = harness({}, [head(1), head(2)], {
      failDeliveryAt: 0,
      onSave: (repo, rows) => { if (repo === REPO) saves.push(rows.map((row) => row.status)); },
    });
    await reconcile();
    expect(delivered).toEqual([]);
    expect(saves).toEqual([["queued", "queued"], ["new", "new"]]);
    expect(saved.get(REPO)!.map((row) => row.error)).toEqual(["delivery failed: Error: unroutable", "delivery failed: Error: unroutable"]);
  });

  test("a deployment that has not recorded credential resolution keeps its heads unqueued until a later pass delivers", async () => {
    const outcomes: Array<Awaited<ReturnType<RunTriggerMaterialize>>> = [{ outcome: "notReady" }, { outcome: "materialized", stepGrants: [] }];
    const routed: string[] = [];
    async function materialize() {
      return outcomes.shift()!;
    }
    async function routeMail(address: string) {
      routed.push(address);
      return true;
    }
    async function tenantDomain() {
      return DOMAIN;
    }
    async function sign() {
      return new Uint8Array(64);
    }
    async function resolve() {
      return { address: `github@${DOMAIN}`, publicKey: "00".repeat(32), sign };
    }
    const trigger = createRunTriggerDeliverer({
      materialize: readyMaterializer(materialize),
      router: { routeMail },
      tenantDomain,
      senderLocalPart: "github",
      systemSender: { resolve },
    });
    async function deliver(tenantId: string, address: string, payload: unknown) {
      await trigger.to(address, JSON.stringify(payload), tenantId, undefined);
    }
    const { reconcile, delivered, saved } = harness({}, [head(1)], { deliver });
    expect(await reconcile()).toEqual({ retry: true });
    expect(routed).toEqual([]);
    expect(saved.get(REPO)!.map((row) => `${row.status}:${row.error}`)).toEqual(["new:delivery failed: Error: The workflow deployment is still starting."]);
    expect(await reconcile()).toEqual({ retry: false });
    expect(routed).toEqual([LIVE.address]);
    expect(mailedNumbers(delivered)).toEqual([1]);
    expect(saved.get(REPO)!.map((row) => row.status)).toEqual(["queued"]);
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

  test("a delivery failure keeps every later repository's heads unqueued and asks for retry", async () => {
    const { reconcile, delivered, saved, logged } = harness({}, { "acme/a": heads(1, 2), "acme/b": heads(10, 2) }, { failDeliveryAt: 1 });
    const outcome = await reconcile();
    expect(outcome.retry).toBe(true);
    expect(mailedHeads(delivered)).toEqual([["acme/a", 1], ["acme/a", 2]]);
    expect(saved.get("acme/a")!.map((row) => row.status)).toEqual(["queued", "queued"]);
    expect(saved.get("acme/b")!.every((row) => row.status === "new")).toBe(true);
    expect(logged.filter((entry) => entry["msg"] === "triage_reconcile_failed").map((entry) => entry["repo"])).toEqual(["acme/b"]);
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
    expect(delivered.map((entry) => entry.address)).toEqual([fresh.address]);
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
    expect(same.delivered.map((entry) => entry.address)).toEqual([newer.address]);

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
    expect(state.delivered.map((entry) => entry.address)).toEqual([portal.address]);
  });

  test("a copy that finished deploying after another deployment landed is released and not mailed", async () => {
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
    expect(delivered.map((entry) => entry.address)).toEqual([portal.address]);
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
    expect(state.delivered.map((entry) => entry.address)).not.toContain(formatRunAddress("run_live_fresh", DOMAIN));
    await state.reconcile();
    expect(state.released).toEqual(["run_live_fresh"]);
  });

  test("a tenant without a GitHub credential is skipped with a reason", async () => {
    const { reconcile, delivered, logged } = harness({}, [head(1)], { github: false });
    await reconcile();
    expect(delivered).toEqual([]);
    expect(logged).toContainEqual(expect.objectContaining({ msg: "triage_reconcile_skipped", reason: "no_github_credential" }));
  });
});
