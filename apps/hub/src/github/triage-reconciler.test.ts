import { describe, expect, test } from "bun:test";
import { formatRunAddress } from "@intx/types";
import { workflowRunRepoIdForAddress, type RepoId, type WorkflowRunEvent, type WorkflowRunReader } from "@intx/hub-sessions";
import { emptyPack, type PrTriageRow } from "@corbits/triage-contracts";
import { DEFAULT_RECONCILE_POLICY, type OpenPr } from "./reconcile-plan.js";
import { createTriageReconciler, type LiveDeployment } from "./triage-reconciler.js";
import { createTriageRuns } from "./triage-runs.js";

const REPO = "acme/widgets";
const DOMAIN = "acme.test";
const TENANT = { id: "tnt_acme", domain: DOMAIN, config: { corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true }] } } };
const LIVE: LiveDeployment = { runId: "run_live", address: formatRunAddress("run_live", DOMAIN) };
const NOW = new Date("2026-10-07T12:00:00.000Z");
const LONG_AGO = "2026-10-07T00:00:00.000Z";

function repoKey(anchorRunId: string): string {
  return workflowRunRepoIdForAddress(formatRunAddress(anchorRunId, DOMAIN)).id;
}

function head(number: number): OpenPr {
  return { number, headSha: `sha${number}`, updatedAt: LONG_AGO };
}

function started(number: number): WorkflowRunEvent {
  const payload = JSON.stringify({ kind: "pr", repo: REPO, prNumber: number, headSha: `sha${number}` });
  return { seq: 0, type: "RunStarted", body: { type: "RunStarted", seq: 0, at: "2026-10-07T01:00:00.000Z", trigger: { type: "mail", payload } } };
}

function rendered(verdict: Record<string, unknown>): WorkflowRunEvent {
  const output = { ref: `inline:${JSON.stringify({ reply: JSON.stringify(verdict), turn: 1 })}` };
  return { seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "render", output } };
}

const completed: WorkflowRunEvent = { seq: 2, type: "RunCompleted", body: { type: "RunCompleted", seq: 2 } };

type Logs = Record<string, Record<string, WorkflowRunEvent[]>>;

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

function harness(logs: Logs, prs: OpenPr[], options: { github?: boolean } = {}) {
  const { reader, reads, latestOf } = fakeReader(logs);
  const delivered: Array<{ address: string; payload: Record<string, unknown> }> = [];
  const saved = new Map<string, PrTriageRow[]>();
  const logged: Array<Record<string, unknown>> = [];
  const reconcile = createTriageReconciler({
    tenants: async function tenants() {
      return [TENANT];
    },
    liveDeployment: async function liveDeployment() {
      return LIVE;
    },
    openHeadsFor: async function openHeadsFor() {
      if (options.github === false) return undefined;
      return async function openHeads() {
        return prs;
      };
    },
    observeRuns: createTriageRuns({ runReader: reader, readSettled: async () => new Map(), maxKnownRuns: 100 }),
    store: {
      async load(_tenantId, repo) {
        return saved.get(repo) ?? [];
      },
      async save(_tenantId, repo, rows) {
        saved.set(repo, rows);
      },
    },
    readCheckPack: async function readCheckPack(_tenantId, repo) {
      return { status: "ok", pack: emptyPack(repo) };
    },
    deliver: async function deliver(_tenantId, address, payload) {
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
      [repoKey("run_old")]: { run_old_pr: [started(1), rendered({ degraded: null }), completed] },
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
        run_clean: [started(3), rendered({ degraded: null, reason: "" }), completed],
      },
    };
    const { reconcile, delivered, saved } = harness(logs, [head(2), head(3)]);
    await reconcile();
    expect(delivered.map((entry) => entry.payload["prNumber"])).toEqual([2]);
    const rows = saved.get(REPO) ?? [];
    expect(rows.find((row) => row.number === 2)).toMatchObject({ status: "queued", attempts: 1 });
    expect(rows.find((row) => row.number === 3)).toMatchObject({ status: "triaged", runId: "run_clean" });
  });

  test("a finished run's log is read once and then left out of later passes", async () => {
    const logs: Logs = { [repoKey(LIVE.runId)]: { run_clean: [started(3), rendered({ degraded: null }), completed] } };
    const { reconcile, reads, latestOf } = harness(logs, [head(3)]);
    await reconcile();
    await reconcile();
    expect(reads).toHaveLength(1);
    expect(latestOf[1]).toEqual([repoKey(LIVE.runId)]);
  });

  test("a tenant without a GitHub credential is skipped with a reason", async () => {
    const { reconcile, delivered, logged } = harness({}, [head(1)], { github: false });
    await reconcile();
    expect(delivered).toEqual([]);
    expect(logged).toContainEqual(expect.objectContaining({ msg: "triage_reconcile_skipped", reason: "no_github_credential" }));
  });
});
