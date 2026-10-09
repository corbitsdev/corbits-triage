import { describe, expect, test } from "bun:test";
import { formatRunAddress } from "@intx/types";
import { workflowRunRepoIdForAddress, type RepoId, type WorkflowRunEvent, type WorkflowRunReader } from "@intx/hub-sessions";
import { emptyPack, type PrTriageRow } from "@corbits/triage-contracts";
import { DEFAULT_RECONCILE_POLICY, type OpenPr } from "./reconcile-plan.js";
import { TriageStateConflictError } from "./triage-state-store.js";
import { createTriageReconciler, type LiveDeployment } from "./triage-reconciler.js";
import { createTriageRuns } from "./triage-runs.js";
import type { ReactorCapabilities, ReactorInboundEvent, ReactorState } from "@intx/types/runtime";
import { triageDirectorFactory } from "../../../../packages/triage-workflows/src/directors.js";

const REPO = "acme/widgets";
const DOMAIN = "acme.test";
const TENANT_ID = "tnt_acme";
const LIVE: LiveDeployment = { runId: "run_live", address: formatRunAddress("run_live", DOMAIN) };
const NOW = new Date("2026-10-07T12:00:00.000Z");
const LONG_AGO = "2026-10-07T00:00:00.000Z";

function repoKey(anchorRunId: string): string {
  return workflowRunRepoIdForAddress(formatRunAddress(anchorRunId, DOMAIN)).id;
}

function head(number: number): OpenPr {
  return { number, headSha: `sha${number}`, updatedAt: LONG_AGO };
}

function heads(from: number, count: number): OpenPr[] {
  return Array.from({ length: count }, (_, i) => head(from + i));
}

function started(number: number, at = "2026-10-07T01:00:00.000Z"): WorkflowRunEvent {
  const payload = JSON.stringify({ kind: "pr", repo: REPO, prNumber: number, headSha: `sha${number}` });
  return { seq: 0, type: "RunStarted", body: { type: "RunStarted", seq: 0, at, trigger: { type: "mail", payload } } };
}

function current(number: number, workflowVersion = 2): Record<string, unknown> {
  return { degraded: null, reason: "", headSha: `sha${number}`, workflowVersion, checks: [] };
}

function rendered(verdict: Record<string, unknown>): WorkflowRunEvent {
  const output = { ref: `inline:${JSON.stringify({ reply: JSON.stringify(verdict), turn: 1 })}` };
  return { seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "render", output } };
}

const completed: WorkflowRunEvent = { seq: 2, type: "RunCompleted", body: { type: "RunCompleted", seq: 2 } };

type Logs = Record<string, Record<string, WorkflowRunEvent[]>>;

/** Drives one real triage director for one inbound event and returns its reply. */
async function directorReply(role: "facts" | "render", event: ReactorInboundEvent): Promise<string> {
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
  failDeliveryAt?: number;
  refuseSaves?: number;
  onRefusedSave?: (repo: string) => void;
  onSave?: (repo: string, rows: PrTriageRow[]) => void;
};

function harness(logs: Logs, prs: OpenPr[] | Record<string, OpenPr[]>, options: HarnessOptions = {}) {
  const repos = Array.isArray(prs) ? { [REPO]: prs } : prs;
  const tenant = { id: TENANT_ID, domain: DOMAIN, config: { corbitsTriage: { repos: Object.keys(repos).map((name) => ({ name, connected: true, enabled: true })) } } };
  const { reader, reads, latestOf } = fakeReader(logs);
  const delivered: Array<{ address: string; payload: Record<string, unknown> }> = [];
  const saved = new Map<string, PrTriageRow[]>();
  let refusals = options.refuseSaves ?? 0;
  const logged: Array<Record<string, unknown>> = [];
  const reconcile = createTriageReconciler({
    tenants: async function tenants() {
      return [tenant];
    },
    liveDeployment: async function liveDeployment() {
      return LIVE;
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
    deliver: async function deliver(_tenantId, address, payload) {
      if (delivered.length === options.failDeliveryAt) throw new Error("unroutable");
      delivered.push({ address, payload: payload as Record<string, unknown> });
    },
    policy: DEFAULT_RECONCILE_POLICY,
    now: () => NOW,
    log: (entry) => logged.push(entry),
  });
  return { reconcile, delivered, saved, logged, reads, latestOf };
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
    expect(delivered[0]).toMatchObject({ address: LIVE.address, payload: { kind: "pr", repo: REPO, prNumber: 1, headSha: "sha1" } });
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
    expect(delivered.map((entry) => entry.payload["prNumber"])).toEqual([2]);
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
    expect(delivered.map((entry) => entry.payload["prNumber"])).toEqual([2, 3]);
    const reasons = logged.filter((entry) => entry["msg"] === "triage_requeued").map((entry) => entry["reason"]);
    expect(reasons).toEqual(["verdict made on head sha2-pushed", "unconfirmed checks: conflicts"]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.filter((row) => row.number !== 4).every((row) => row.status === "queued" && row.attempts === 1 && row.workflowVersion === 2)).toBe(true);
    expect(rows.find((row) => row.number === 4)).toMatchObject({ status: "triaged", runId: "run_not_asked", workflowVersion: 2 });
  });

  test("a facts failure renders a degraded verdict naming no head, which is queued again with the facts error", async () => {
    const item = await directorReply("facts", { type: "abort" } as ReactorInboundEvent);
    const verdict = JSON.parse(await directorReply("render", { type: "message.received", message: { content: item } } as ReactorInboundEvent));
    expect(verdict).toMatchObject({ degraded: "error", headSha: null, reason: "facts interrupted: abort" });
    const logs: Logs = { [repoKey(LIVE.runId)]: { run_fail: [started(1), rendered(verdict), completed] } };
    const { reconcile, delivered, logged } = harness(logs, [head(1)]);
    await reconcile();
    expect(delivered.map((entry) => entry.payload["prNumber"])).toEqual([1]);
    expect(logged.find((entry) => entry["msg"] === "triage_requeued")?.["reason"]).toBe("degraded: facts interrupted: abort");
  });

  test("one verdict from a newer workflow version re-queues heads settled under the older one", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: { run_v2: [started(9), rendered(current(9, 2)), completed] } };
    const { reconcile, delivered, saved, logged } = harness(logs, [head(1), head(2), head(9)]);
    const settled = (number: number): PrTriageRow => ({ number, headSha: `sha${number}`, status: "triaged", attempts: 0, runId: `old_${number}`, workflowVersion: 1, firstSeenAt: LONG_AGO, updatedAt: LONG_AGO });
    saved.set(REPO, [settled(1), settled(2)]);
    await reconcile();
    expect(delivered.map((entry) => entry.payload["prNumber"])).toEqual([1, 2]);
    expect(logged.filter((entry) => entry["msg"] === "triage_requeued").every((entry) => entry["reason"] === "verdict from workflow version 1, current is 2")).toBe(true);
    const rows = saved.get(REPO) ?? [];
    expect(rows.filter((row) => row.number !== 9).every((row) => row.status === "queued" && row.attempts === 1 && row.workflowVersion === 2)).toBe(true);
    expect(rows.find((row) => row.number === 9)).toMatchObject({ status: "triaged", runId: "run_v2", workflowVersion: 2 });
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
    expect(delivered.map((entry) => [entry.payload["repo"], entry.payload["prNumber"]])).toEqual([["acme/one", 1], ["acme/one", 2], ["acme/one", 3], ["acme/two", 100], ["acme/two", 101]]);
  });

  test("queued heads that have not started hold the budget until their runs complete", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: {} };
    const { reconcile, delivered, saved } = harness(logs, heads(1, 12));
    await reconcile();
    await reconcile();
    expect(delivered.map((entry) => entry.payload["prNumber"])).toEqual([1, 2, 3, 4, 5]);
    // Only a run started since the hub queued the head settles it.
    for (const number of [1, 2, 3, 4, 5]) logs[repoKey(LIVE.runId)]![`run_${number}`] = [started(number, "2026-10-07T12:00:30.000Z"), rendered(current(number)), completed];
    await reconcile();
    expect(delivered.map((entry) => entry.payload["prNumber"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.filter((row) => row.status === "triaged").map((row) => row.number)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.filter((row) => row.status === "new").map((row) => row.number)).toEqual([11, 12]);
  });

  test("queued heads are written before any mail goes out, and a head whose mail fails is put back", async () => {
    const saves: string[][] = [];
    const { reconcile, delivered, saved } = harness({}, [head(1), head(2)], {
      failDeliveryAt: 1,
      onSave: (repo, rows) => { if (repo === REPO) saves.push(rows.map((row) => row.status)); },
    });
    await reconcile();
    expect(delivered.map((entry) => entry.payload["prNumber"])).toEqual([1]);
    expect(saves).toEqual([["queued", "queued"], ["queued", "new"]]);
    expect(saved.get(REPO)!.find((row) => row.number === 2)?.error).toBe("delivery failed: Error: unroutable");
  });

  test("a state write refused as stale is retried once on the other writer's rows, keeping the newer row of each head", async () => {
    const { reconcile, delivered, saved, logged } = harness({}, [head(1), head(2)], {
      refuseSaves: 1,
      onRefusedSave: (repo) => saved.set(repo, [{ number: 1, headSha: "sha1", status: "queued", attempts: 3, firstSeenAt: LONG_AGO, queuedAt: "2026-10-07T12:00:30.000Z", updatedAt: "2026-10-07T12:00:30.000Z" }]),
    });
    await reconcile();
    const rows = saved.get(REPO) ?? [];
    expect(rows.map((row) => `${row.number}:${row.status}:${row.attempts}`)).toEqual(["1:queued:3", "2:queued:1"]);
    expect(delivered.map((entry) => entry.payload["prNumber"])).toEqual([2]);
    expect(logged).toContainEqual(expect.objectContaining({ msg: "triage_state_merged", repo: REPO, left: 1 }));
    const twice = harness({}, [head(1)], { refuseSaves: 2 });
    await twice.reconcile();
    expect(twice.saved.get(REPO)).toBeUndefined();
    expect(twice.delivered).toEqual([]);
    expect(twice.logged).toContainEqual(expect.objectContaining({ msg: "triage_state_conflict", repo: REPO }));
  });

  test("a head still running holds one of the tenant's slots", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: { run_going: [started(1, "2026-10-07T11:55:00.000Z")] } };
    const { reconcile, delivered } = harness(logs, heads(1, 7));
    await reconcile();
    expect(delivered.map((entry) => entry.payload["prNumber"])).toEqual([2, 3, 4, 5]);
  });

  test("a delivery failure keeps every later head unqueued across repositories and asks for retry", async () => {
    const { reconcile, delivered, saved, logged } = harness({}, { "acme/a": heads(1, 2), "acme/b": heads(10, 2) }, { failDeliveryAt: 1 });
    const outcome = await reconcile();
    expect(outcome.retry).toBe(true);
    expect(delivered.map((entry) => [entry.payload["repo"], entry.payload["prNumber"]])).toEqual([["acme/a", 1]]);
    expect(saved.get("acme/a")!.map((row) => row.status)).toEqual(["queued", "new"]);
    expect(saved.get("acme/b")!.every((row) => row.status === "new")).toBe(true);
    expect(logged.filter((entry) => entry["msg"] === "triage_reconcile_failed").map((entry) => entry["repo"])).toEqual(["acme/a"]);
  });

  test("heads first seen together queue lowest pull request number first, whatever order GitHub lists them", async () => {
    const { reconcile, delivered } = harness({}, heads(1, 10).reverse());
    await reconcile();
    expect(delivered.map((entry) => entry.payload["prNumber"])).toEqual([1, 2, 3, 4, 5]);
  });

  test("a tenant without a GitHub credential is skipped with a reason", async () => {
    const { reconcile, delivered, logged } = harness({}, [head(1)], { github: false });
    await reconcile();
    expect(delivered).toEqual([]);
    expect(logged).toContainEqual(expect.objectContaining({ msg: "triage_reconcile_skipped", reason: "no_github_credential" }));
  });
});
