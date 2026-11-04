import { describe, expect, test } from "bun:test";
import { checkPackName, emptyPack, type PrTriageRow } from "@corbits/triage-contracts";
import type { CodeReviewRecord } from "../manager-state.js";
import { createGithubPrTriage, type GithubPrTriageDeps } from "./pr-triage.js";
import { DEFAULT_RECONCILE_POLICY, type ObservedRun } from "./reconcile-plan.js";
import type { TriageStateVersion } from "./triage-state-store.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const TENANT_ID = "tenant-1";
const MEMBER = { tenantId: TENANT_ID, principalId: "member-1" };
const REPO = "acme/widgets";
const CREDENTIAL_ID = "crd_github";
const NOW = new Date("2026-10-08T12:00:00Z");
const PACK = { ...emptyPack(REPO), checks: { "no-merge-conflicts": { enabled: true } } };
const ENABLED = { name: REPO, connected: true, enabled: true };
const LISTENER = { runId: "listener-1", address: "listener-1@tenant.example", createdAt: NOW, cancelling: false };

type Delivered = { payload: unknown };
type Stub = { delivered: Delivered[]; saved: PrTriageRow[][]; authorized: unknown[][] };

function stubDb(repo: Record<string, unknown>) {
  return {
    query: {
      credential: { async findFirst() { return { id: CREDENTIAL_ID, secret: "sealed", status: "active", principalId: null }; } },
      tenant: { async findFirst() { return { domain: "tenant.example", config: { corbitsTriage: { repos: [repo] } } }; } },
    },
  } as never;
}

function observed(runs: ObservedRun[]): GithubPrTriageDeps["managerRuns"] {
  return async function managerRuns() {
    return { byRepo: new Map([[REPO, new Map([["8@abc123", runs]])]]), roomless: new Set<string>(), runCount: runs.length, verdicts: [], approved: [] };
  };
}

const VERSION: TriageStateVersion = { artifactId: "art_state", version: 1 };

/** Rows that move with each save, so a reload sees the last write. */
function stored(rows: PrTriageRow[], saved: PrTriageRow[][]): GithubPrTriageDeps["store"] {
  let current = rows;
  return {
    async load() {
      return { rows: current, version: VERSION };
    },
    async save(_tenant, _repo, next) {
      current = next;
      saved.push(next);
      return VERSION;
    },
  };
}

function stub(): Stub {
  return { delivered: [], saved: [], authorized: [] };
}

function handler(repo: Record<string, unknown>, s: Stub, overrides: Partial<GithubPrTriageDeps> = {}) {
  return createGithubPrTriage({
    db: stubDb(repo),
    cipher: { async decrypt() { return "{}"; } } as never,
    onKeyMoved: noKeyPush,
    authorize: async (...args) => {
      s.authorized.push(args);
      return true;
    },
    pullHead: async (_tenantId, _record, number) => (number === 8 ? "abc123" : undefined),
    readCheckPack: async () => ({ status: "ok", pack: PACK, automatic: [], source: { file: { path: ".corbits-triage.yml", sha: "art_pack-1" } } }),
    listener: async () => LISTENER,
    managerRuns: observed([]),
    codeReviews: async () => [],
    store: stored([], s.saved),
    send: async ({ payload }) => {
      s.delivered.push({ payload });
    },
    retry() {},
    policy: DEFAULT_RECONCILE_POLICY,
    now: () => NOW,
    log: () => {},
    ...overrides,
  });
}

function request(number = 8) {
  return { repo: REPO, number };
}

async function refused(res: Response, status: number, code: string, details?: Record<string, string>): Promise<void> {
  expect(res.status).toBe(status);
  expect(await res.json()).toMatchObject({ error: { code, ...details } });
}

describe("createGithubPrTriage", () => {
  test("sends the bridge's payload and remembers the head as queued", async () => {
    const s = stub();
    const res = await handler(ENABLED, s)(request(), MEMBER);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued", headSha: "abc123" });
    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0]!.payload).toMatchObject({
      kind: "pr",
      repo: REPO,
      prNumber: 8,
      headSha: "abc123",
      policy: { enabled: true, checkPack: { name: checkPackName(REPO, "github") } },
    });
    expect((s.delivered[0]!.payload as { pack: unknown }).pack).toEqual(PACK);
    const at = NOW.toISOString();
    expect(s.saved).toEqual([[{ number: 8, headSha: "abc123", status: "queued", attempts: 0, firstSeenAt: at, queuedAt: at, updatedAt: at }]]);
  });

  test("on a head whose code review failed, it asks for one more review as Review again does; on one whose review finished, it does not", async () => {
    const readCheckPack: GithubPrTriageDeps["readCheckPack"] = async () => ({ status: "ok", pack: PACK, automatic: [], source: { file: { path: ".corbits-triage.yml", sha: "art_pack-1" } }, policyWorkflow: { "code-review": { on: true } } });
    const at = NOW.toISOString();
    const failed: CodeReviewRecord[] = [
      { runId: "review-1", head: "abc123", at, state: "failed", failed: "the reviewer's run ended" },
      { runId: "review-2", head: "abc123", at, state: "reported", payload: { kind: "code-review", failed: "the reviewer failed" } },
    ];
    const finished: CodeReviewRecord[] = [...failed, { runId: "review-3", head: "abc123", at, state: "reported", payload: { kind: "code-review", result: {} } }];
    const s = stub();
    await handler(ENABLED, s, { readCheckPack, codeReviews: async () => failed })(request(), MEMBER);
    await handler(ENABLED, stub(), { readCheckPack, store: stored([], []), codeReviews: async () => finished, send: async ({ payload }) => { s.delivered.push({ payload }); } })(request(), MEMBER);
    const [again, done] = s.delivered.map((mail) => (mail.payload as { codeReview: Record<string, unknown> }).codeReview);
    expect(again).toMatchObject({ on: true, again: expect.any(String) });
    expect(done).toEqual({ on: true, for: expect.any(Array), triage: expect.any(Array), rules: "pass" });
  });

  test("a member denied use of the GitHub App credential gets 403 and nothing is mailed", async () => {
    const s = stub();
    const authorize: GithubPrTriageDeps["authorize"] = async (...args) => {
      s.authorized.push(args);
      return false;
    };
    await refused(await handler(ENABLED, s, { authorize })(request(), MEMBER), 403, "forbidden");
    expect(s.authorized).toEqual([["member-1", TENANT_ID, `credential:${CREDENTIAL_ID}`, "use"]]);
    expect(s.delivered).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  test("refuses a repository whose triage is disabled and mails nothing", async () => {
    const s = stub();
    await refused(await handler({ ...ENABLED, enabled: false }, s)(request(), MEMBER), 409, "repo_not_enabled");
    expect(s.delivered).toEqual([]);
  });

  test("refuses a repository with no policy file or one triage refuses, each by name", async () => {
    const s = stub();
    await refused(await handler(ENABLED, s, { readCheckPack: async () => ({ status: "missing" }) })(request(), MEMBER), 409, "needs_setup");
    await refused(await handler(ENABLED, s, { readCheckPack: async () => ({ status: "invalid", reason: "Line 1: max-size is not a check.", path: ".corbits-triage.yml", automatic: [] }) })(request(), MEMBER), 409, "policy_file_invalid", { reason: "Line 1: max-size is not a check." });
    expect(s.delivered).toEqual([]);
  });

  test("refuses a head whose run is still going, but not one that is stuck", async () => {
    const live: ObservedRun = { runId: "run-live", source: "github", status: "running", startedAt: new Date(NOW.getTime() - 60_000).toISOString() };
    const stuckSince = new Date(NOW.getTime() - 2 * DEFAULT_RECONCILE_POLICY.stuckAfterMs).toISOString();
    const stuck: ObservedRun = { runId: "run-stuck", source: "github", status: "running", startedAt: stuckSince, passAt: stuckSince };
    const s = stub();
    await refused(await handler(ENABLED, s, { managerRuns: observed([live]) })(request(), MEMBER), 409, "already_running");
    expect(s.delivered).toEqual([]);
    expect((await handler(ENABLED, s, { managerRuns: observed([stuck]) })(request(), MEMBER)).status).toBe(202);
    expect(s.delivered).toHaveLength(1);
  });
});
