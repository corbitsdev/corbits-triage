import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { emptyPack, recommendedPack, repoPolicy, type CheckPack, type CustomCheck } from "@corbits/triage-contracts";
import { applyInstallationListing, createBridgeHandler, loadBridgeHook, mailPayload, type BridgeDeps } from "./bridge.js";
import { MAX_BODY_BYTES } from "../read-json.js";
import { repoRecords } from "./tenant-config.js";
import { DeliveryCache } from "./dedupe.js";
import type { CoalescedEvent } from "./coalescer.js";
import { verifySignature } from "./signature.js";

const SECRET = "test-webhook-secret";
const HOOK_ID = "crd_test123";
const TENANT_ID = "tnt_test";
const TARGET = { hookId: HOOK_ID };
const CONNECTED_HELLO = { corbitsTriage: { repos: [{ name: "octocat/hello", connected: true, enabled: true }] } };

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function githubRequest(body: string, init: { delivery?: string; event?: string; signature?: string } = {}): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "x-hub-signature-256": init.signature ?? sign(body),
    "x-github-delivery": init.delivery ?? "del-1",
    "x-github-event": init.event ?? "pull_request",
  });
  return new Request(`https://hub.example/api/hooks/${HOOK_ID}`, { method: "POST", headers, body });
}

const prPayload = JSON.stringify({
  action: "opened",
  repository: { full_name: "octocat/hello" },
  pull_request: { number: 7, head: { sha: "abc" }, user: { login: "octocat" }, title: "Fix", body: "Body" },
});

type Row = {
  id: string;
  tenantId: string;
  principalId: string | null;
  name: string;
  status: string;
  secret: string;
  metadata: unknown;
};

type StubDb = BridgeDeps["db"] & { tenantConfig(): unknown };

const APP_ROW = { id: "crd_app", tenantId: TENANT_ID, name: "github", metadata: { appSlug: "corbits-triage" } };

function asksForName(node: unknown, name: string): boolean {
  if (node === name) return true;
  if (!node || typeof node !== "object") return false;
  const chunks = (node as { queryChunks?: unknown[]; value?: unknown }).queryChunks;
  if (Array.isArray(chunks)) return chunks.some((chunk) => asksForName(chunk, name));
  return asksForName((node as { value?: unknown }).value, name);
}

function stubDb(rows: Row[], config: unknown = CONNECTED_HELLO, opts: { missingTenant?: boolean } = {}): StubDb {
  const box = { config };
  function tenantRows() {
    return opts.missingTenant ? [] : [{ id: TENANT_ID, config: box.config }];
  }
  const tx = {
    select() {
      return { from() { return { where() { return { async for() { return tenantRows(); } }; } }; } };
    },
    update() {
      return {
        set(values: { config?: unknown }) {
          return {
            async where() {
              if (values.config !== undefined) box.config = values.config;
            },
          };
        },
      };
    },
  };
  return {
    query: {
      credential: {
        async findFirst(args?: { where?: unknown }) {
          return asksForName(args?.where, "github") ? APP_ROW : rows[0];
        },
      },
      tenant: {
        async findFirst() {
          return tenantRows()[0];
        },
      },
    },
    async transaction(fn: (value: typeof tx) => unknown) {
      return fn(tx);
    },
    tenantConfig() {
      return box.config;
    },
  } as never;
}

const stubCipher = {
  async decrypt() {
    return SECRET;
  },
} as never;

/** One rule on, so the hub starts runs; `emptyPack` alone has every rule off. */
function rulePack(repo: string): CheckPack {
  return { ...emptyPack(repo), checks: { "no-merge-conflicts": { enabled: true } } };
}

function packsFor(repos: string[], pack = rulePack): BridgeDeps["readCheckPack"] {
  const packs = new Map(repos.map((repo) => [repo, pack(repo)]));
  return async function readCheckPack(_tenant, repo) {
    const pack = packs.get(repo);
    return pack ? { status: "ok", pack, automatic: [], source: { repo: { id: "art_pack", version: 1 } } } : { status: "missing" };
  };
}

function hookRow(overrides: Partial<Row> = {}): Row {
  return {
    id: HOOK_ID,
    tenantId: TENANT_ID,
    principalId: null,
    name: "github-hook",
    status: "active",
    secret: "sealed",
    metadata: { webhook: { verify: "standard-webhooks", workflow: "pr-triage" } },
    ...overrides,
  };
}

type Sent = CoalescedEvent;

function ignoreLog(): void {}

function openHeadOf(drafts: number[]): BridgeDeps["openHeadFor"] {
  return async function openHeadFor() {
    return async function openHead(_record, number) {
      return { headSha: `sha${number}`, draft: drafts.includes(number) };
    };
  };
}

type Recheck = [string, string, number];
type Synced = [string, boolean];

function bridge({ synced = [], ...overrides }: Partial<BridgeDeps> & { sent?: Sent[]; rechecks?: Recheck[]; synced?: Synced[] } = {}) {
  const sent = overrides.sent ?? [];
  const rechecks = overrides.rechecks ?? [];
  async function accept(input: CoalescedEvent) {
    sent.push(input);
    return "queued" as const;
  }
  async function recheckOpenPulls(tenantId: string, repo: string, except: number) {
    rechecks.push([tenantId, repo, except]);
    return 1;
  }
  return createBridgeHandler({
    db: stubDb([hookRow()]),
    cipher: stubCipher,
    cache: new DeliveryCache(),
    coalescer: { accept },
    log: ignoreLog,
    readCheckPack: packsFor(["octocat/hello"]),
    openHeadFor: openHeadOf([]),
    recheckOpenPulls,
    async syncPolicyFile(_tenantId, repo, removed) {
      synced.push([repo, removed]);
      return { status: "synced", sha: "blob1" };
    },
    ...overrides,
  });
}

function flakyCoalescer(sent: Sent[], failures: number): BridgeDeps["coalescer"] {
  let calls = 0;
  return {
    async accept(input) {
      calls += 1;
      if (calls <= failures) throw new Error("state store down");
      sent.push(input);
      return "queued";
    },
  };
}

describe("verifySignature", () => {
  test("accepts a valid HMAC", () => {
    expect(verifySignature(SECRET, prPayload, sign(prPayload))).toBe(true);
  });
  test("rejects wrong secret, missing prefix and missing header", () => {
    expect(verifySignature("other", prPayload, sign(prPayload))).toBe(false);
    expect(verifySignature(SECRET, prPayload, "md5=abc")).toBe(false);
    expect(verifySignature(SECRET, prPayload, null)).toBe(false);
  });
});

describe("loadBridgeHook", () => {
  test("loads an active tenant-owned hook credential", async () => {
    const hook = await loadBridgeHook(stubDb([hookRow()]), stubCipher, HOOK_ID, undefined);
    expect(hook).toMatchObject({ credentialId: HOOK_ID, tenantId: TENANT_ID, secret: SECRET, workflow: "pr-triage" });
  });
  test("rejects revoked, personal and non-webhook credentials", async () => {
    expect(await loadBridgeHook(stubDb([hookRow({ status: "revoked" })]), stubCipher, HOOK_ID, undefined)).toBeUndefined();
    expect(await loadBridgeHook(stubDb([hookRow({ principalId: "prn_1" })]), stubCipher, HOOK_ID, undefined)).toBeUndefined();
    expect(await loadBridgeHook(stubDb([hookRow({ metadata: {} })]), stubCipher, HOOK_ID, undefined)).toBeUndefined();
  });
  test("name lookup without a tenant hint misses", async () => {
    expect(await loadBridgeHook(stubDb([hookRow()]), stubCipher, "github-hook", undefined)).toBeUndefined();
  });
  test("metadata.webhook to wins over workflow", async () => {
    const db = stubDb([hookRow({ metadata: { webhook: { verify: "standard-webhooks", workflow: "pr-triage", to: "pr-triage-historical" } } })]);
    expect(await loadBridgeHook(db, stubCipher, HOOK_ID, undefined)).toMatchObject({ workflow: "pr-triage-historical" });
  });
});

describe("bridge handler", () => {
  test("queues a valid delivery with the repo policy for the hook workflow", async () => {
    const sent: Sent[] = [];
    const res = await bridge({ sent })(githubRequest(prPayload), TARGET);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued" });
    expect(sent).toEqual([expect.objectContaining({
      workflow: "pr-triage",
      number: 7,
      headSha: "abc",
      event: "opened",
      mail: expect.objectContaining({ repo: "octocat/hello", prNumber: 7 }),
      policy: expect.objectContaining({
        enabled: true,
        checks: { ci: true, conflicts: true },
      }),
    })]);
  });

  test("carries the review state only on a pull request review", async () => {
    const sent: Sent[] = [];
    const handle = bridge({ sent });
    const pr = JSON.parse(prPayload);
    const review = JSON.stringify({ ...pr, action: "submitted", review: { state: "approved" } });
    const checkRun = JSON.stringify({
      action: "completed",
      repository: { full_name: "octocat/hello" },
      check_run: { head_sha: "sha7", pull_requests: [{ number: 7, head: { sha: "sha7" } }] },
    });
    await handle(githubRequest(review, { delivery: "r1", event: "pull_request_review" }), TARGET);
    await handle(githubRequest(checkRun, { delivery: "r2", event: "check_run" }), TARGET);
    expect(sent.map((item) => item.mail)).toEqual([
      expect.objectContaining({ event: "pull_request_review", review: { state: "approved" } }),
      expect.objectContaining({ event: "check_run", review: null }),
    ]);
  });

  test("routes to the hook's configured workflow", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow({ metadata: { webhook: { verify: "standard-webhooks", workflow: "pr-triage-historical" } } })]);
    expect((await bridge({ db, sent })(githubRequest(prPayload), TARGET)).status).toBe(202);
    expect(sent.map((item) => item.workflow)).toEqual(["pr-triage-historical"]);
  });

  test("unknown hook is 404", async () => {
    const sent: Sent[] = [];
    const res = await bridge({ db: stubDb([]), sent })(githubRequest(prPayload), TARGET);
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test("oversize bodies are 413 without delivery", async () => {
    const sent: Sent[] = [];
    const res = await bridge({ sent })(githubRequest("x".repeat(MAX_BODY_BYTES + 1), { delivery: "big" }), TARGET);
    expect(res.status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  test("bad signature is 401", async () => {
    const sent: Sent[] = [];
    const res = await bridge({ sent })(githubRequest(prPayload, { signature: "sha256=deadbeef" }), TARGET);
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  test("missing GitHub delivery headers is 400", async () => {
    const req = new Request(`https://hub.example/api/hooks/${HOOK_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(prPayload) },
      body: prPayload,
    });
    expect((await bridge()(req, TARGET)).status).toBe(400);
  });

  test("duplicates are 200 without redelivery", async () => {
    const sent: Sent[] = [];
    const handle = bridge({ sent });
    expect((await handle(githubRequest(prPayload, { delivery: "dup" }), TARGET)).status).toBe(202);
    const second = await handle(githubRequest(prPayload, { delivery: "dup" }), TARGET);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "duplicate" });
    expect(sent).toHaveLength(1);
  });

  test("closed pull requests are 202 ignored", async () => {
    const sent: Sent[] = [];
    const base = JSON.parse(prPayload);
    const closed = JSON.stringify({ ...base, pull_request: { ...base.pull_request, state: "closed" } });
    const res = await bridge({ sent })(githubRequest(closed), TARGET);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(sent).toHaveLength(0);
  });

  test("a merge into the default branch re-checks that repository's other open pull requests", async () => {
    const sent: Sent[] = [];
    const rechecks: Recheck[] = [];
    const db = stubDb([hookRow()], { corbitsTriage: { repos: [{ name: "octocat/hello", connected: true, enabled: true }, { name: "octocat/other", connected: true, enabled: false }] } });
    const handle = bridge({ db, sent, rechecks });
    const pr = JSON.parse(prPayload);
    function closed(repo: string, merged: boolean, base: string) {
      return JSON.stringify({ ...pr, action: "closed", repository: { full_name: repo, default_branch: "main" }, pull_request: { ...pr.pull_request, state: "closed", merged, base: { ref: base } } });
    }
    const deliveries: Array<[string, string, string]> = [
      ["pull_request", closed("octocat/hello", true, "main"), "accepted"],
      ["pull_request", closed("octocat/hello", false, "main"), "ignored"],
      ["pull_request", closed("octocat/hello", true, "release"), "ignored"],
      ["pull_request", closed("octocat/other", true, "main"), "ignored"],
    ];
    for (const [i, [event, body, status]] of deliveries.entries()) {
      const res = await handle(githubRequest(body, { event, delivery: `m${i}` }), TARGET);
      expect(await res.json()).toEqual({ status });
    }
    expect(rechecks).toEqual([[TENANT_ID, "octocat/hello", 7]]);
    expect(sent).toHaveLength(0);
  });

  test("a push to the default branch that changes or removes the policy file, or is forced, syncs it", async () => {
    const synced: Synced[] = [];
    const handle = bridge({ synced });
    function push(ref: string, commit: Record<string, string[]>, forced = false) {
      return JSON.stringify({ ref, forced, repository: { full_name: "octocat/hello", default_branch: "main" }, commits: [commit] });
    }
    const deliveries: Array<[string, string]> = [
      [push("refs/heads/main", { modified: [".corbits-triage.yaml"] }), "accepted"],
      [push("refs/heads/main", { removed: [".corbits-triage.yaml"] }), "accepted"],
      [push("refs/heads/main", { modified: ["README.md"] }, true), "accepted"],
      [push("refs/heads/main", { modified: ["README.md"] }), "ignored"],
      [push("refs/heads/feature", { modified: [".corbits-triage.yaml"] }), "ignored"],
    ];
    for (const [i, [body, status]] of deliveries.entries()) {
      const res = await handle(githubRequest(body, { event: "push", delivery: `p${i}` }), TARGET);
      expect(await res.json()).toEqual({ status });
    }
    expect(synced).toEqual([["octocat/hello", false], ["octocat/hello", true], ["octocat/hello", false]]);
  });

  test("a base move the triage state refused is 500 and releases the id for retry", async () => {
    let refusals = 1;
    const rechecks: Recheck[] = [];
    async function recheckOpenPulls(tenantId: string, repo: string, except: number) {
      if (refusals-- > 0) throw new Error("triage state for octocat/hello changed since it was loaded");
      rechecks.push([tenantId, repo, except]);
      return 1;
    }
    const pr = JSON.parse(prPayload);
    const merged = JSON.stringify({ ...pr, action: "closed", repository: { full_name: "octocat/hello", default_branch: "main" }, pull_request: { ...pr.pull_request, state: "closed", merged: true, base: { ref: "main" } } });
    const handle = bridge({ recheckOpenPulls });
    expect((await handle(githubRequest(merged, { delivery: "moved" }), TARGET)).status).toBe(500);
    expect(await (await handle(githubRequest(merged, { delivery: "moved" }), TARGET)).json()).toEqual({ status: "accepted" });
    expect(rechecks).toEqual([[TENANT_ID, "octocat/hello", 7]]);
  });

  test("unactionable events are 202 ignored", async () => {
    const sent: Sent[] = [];
    const res = await bridge({ sent })(githubRequest(JSON.stringify({ zen: "hi" }), { event: "ping" }), TARGET);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(sent).toHaveLength(0);
  });

  test("only deliveries that map to a triage event mail", async () => {
    const sent: Sent[] = [];
    const handle = bridge({ sent });
    const pr = JSON.parse(prPayload);
    function checkRun(action: string) {
      return JSON.stringify({
        action,
        repository: { full_name: "octocat/hello" },
        check_run: { head_sha: "sha7", pull_requests: [{ number: 7, head: { sha: "sha7" } }] },
      });
    }
    const deliveries: Array<[string, string, string]> = [
      ["pull_request", JSON.stringify({ ...pr, action: "labeled" }), "ignored"],
      ["check_run", checkRun("created"), "ignored"],
      ["check_run", checkRun("completed"), "queued"],
      ["pull_request", JSON.stringify({ ...pr, action: "synchronize" }), "queued"],
    ];
    for (const [index, [event, body, status]] of deliveries.entries()) {
      expect(await (await handle(githubRequest(body, { delivery: `e${index}`, event }), TARGET)).json()).toEqual({ status });
    }
    expect(sent.map((item) => item.mail.action)).toEqual(["completed", "synchronize"]);
  });

  test("events sent by the workspace's own app bot are ignored", async () => {
    const sent: Sent[] = [];
    const own = JSON.stringify({ ...JSON.parse(prPayload), action: "synchronize", sender: { type: "Bot", login: "corbits-triage[bot]" } });
    const res = await bridge({ sent })(githubRequest(own), TARGET);
    expect(await res.json()).toEqual({ status: "ignored" });
    const other = JSON.stringify({ ...JSON.parse(prPayload), action: "synchronize", sender: { type: "Bot", login: "dependabot[bot]" } });
    expect(await (await bridge({ sent })(githubRequest(other, { delivery: "del-2" }), TARGET)).json()).toEqual({ status: "queued" });
    expect(sent).toHaveLength(1);
  });

  test("unconfigured repositories are 202 ignored", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], { corbitsTriage: { repos: [{ name: "octocat/other", connected: true, enabled: true }] } });
    const res = await bridge({ db, sent })(githubRequest(prPayload), TARGET);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(sent).toHaveLength(0);
  });

  test("a disabled repo is 202 ignored", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], {
      corbitsTriage: { repos: [{ name: "octocat/hello", connected: true, enabled: false }] },
    });
    const res = await bridge({ db, sent })(githubRequest(prPayload), TARGET);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(sent).toHaveLength(0);
  });

  test("a draft is 202 ignored, read from the event or else from GitHub, and triaged once marked ready", async () => {
    const stored = { corbitsTriage: { repos: [{ name: "octocat/hello", connected: true, enabled: true, triageDrafts: true }] } };
    const pr = JSON.parse(prPayload);
    const draftOpened = JSON.stringify({ ...pr, pull_request: { ...pr.pull_request, draft: true } });
    const markedReady = JSON.stringify({ ...pr, action: "ready_for_review", pull_request: { ...pr.pull_request, draft: false } });
    const checkRun = JSON.stringify({
      action: "completed",
      repository: { full_name: "octocat/hello" },
      check_run: { head_sha: "sha7", pull_requests: [{ number: 7, head: { sha: "sha7" } }] },
    });
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], stored);
    const drafts = bridge({ db, sent, openHeadFor: openHeadOf([7]) });
    expect(await (await drafts(githubRequest(draftOpened, { delivery: "d1" }), TARGET)).json()).toEqual({ status: "ignored" });
    expect(await (await drafts(githubRequest(checkRun, { delivery: "d2", event: "check_run" }), TARGET)).json()).toEqual({ status: "ignored" });
    expect(sent).toHaveLength(0);
    const ready = bridge({ db, sent, openHeadFor: openHeadOf([]) });
    expect(await (await ready(githubRequest(markedReady, { delivery: "d3" }), TARGET)).json()).toEqual({ status: "queued" });
    expect(await (await ready(githubRequest(checkRun, { delivery: "d4", event: "check_run" }), TARGET)).json()).toEqual({ status: "queued" });
    expect(sent.map(({ event, headSha }) => [event, headSha])).toEqual([["ready", "abc"], ["checks", "sha7"]]);
  });

  test("a conversion to draft is triaged once, so the verdict stops offering the pull request as ready", async () => {
    const sent: Sent[] = [];
    const pr = JSON.parse(prPayload);
    const converted = JSON.stringify({ ...pr, action: "converted_to_draft", pull_request: { ...pr.pull_request, draft: true } });
    const handle = bridge({ sent, openHeadFor: openHeadOf([7]) });
    expect(await (await handle(githubRequest(converted, { delivery: "d1" }), TARGET)).json()).toEqual({ status: "queued" });
    expect(sent.map(({ event, headSha }) => [event, headSha])).toEqual([["drafted", "abc"]]);
  });

  test("a policy with every rule off starts no run and writes nothing", async () => {
    const sent: Sent[] = [];
    const logged: Array<Record<string, unknown>> = [];
    const res = await bridge({ sent, readCheckPack: packsFor(["octocat/hello"], emptyPack), log: (entry) => logged.push(entry) })(githubRequest(prPayload), TARGET);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(sent).toHaveLength(0);
    expect(logged).toContainEqual(expect.objectContaining({ msg: "triage_skipped_no_rules", repo: "octocat/hello" }));
  });

  test("a repo without a check pack is needs-setup and does not mail", async () => {
    const sent: Sent[] = [];
    const res = await bridge({ sent, readCheckPack: packsFor([]) })(githubRequest(prPayload), TARGET);
    expect(await res.json()).toEqual({ status: "needs-setup" });
    expect(sent).toHaveLength(0);
  });

  test("a failed queue write is 500 and releases the id for retry", async () => {
    const sent: Sent[] = [];
    const handle = bridge({ coalescer: flakyCoalescer(sent, 1) });
    const failed = await handle(githubRequest(prPayload, { delivery: "retry" }), TARGET);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "triage_state_unavailable" });
    expect((await handle(githubRequest(prPayload, { delivery: "retry" }), TARGET)).status).toBe(202);
    expect(sent).toHaveLength(1);
  });
});

const INSTALLATION = {
  id: 42,
  account: { login: "octocat" },
  html_url: "https://github.com/settings/installations/42",
  repository_selection: "selected" as const,
};

function installRequest(event: string, body: unknown, delivery: string): Request {
  return githubRequest(JSON.stringify(body), { event, delivery });
}

function repos(db: StubDb): Array<Record<string, unknown>> {
  return (db.tenantConfig() as { corbitsTriage: { repos: Array<Record<string, unknown>> } }).corbitsTriage.repos;
}

describe("bridge installation events", () => {
  test("created upserts listed repos, keeping existing policy", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], {
      corbitsTriage: {
        repos: [{
          name: "octocat/hello",
          connected: true,
          installationId: 42,
          triageDrafts: false,
          enabled: false,
          checks: { ci: true, conflicts: false },
        }],
      },
    });
    const res = await bridge({ db, sent })(installRequest("installation", {
      action: "created",
      installation: INSTALLATION,
      repositories: [{ full_name: "octocat/hello" }, { full_name: "octocat/world" }],
    }, "created-1"), TARGET);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(repos(db)).toEqual([
      expect.objectContaining({
        name: "octocat/hello",
        connected: true,
        installationId: 42,
        account: "octocat",
        installationUrl: "https://github.com/settings/installations/42",
        selection: "selected",
        triageDrafts: false,
        enabled: false,
        checks: expect.objectContaining({ conflicts: false }),
      }),
      expect.objectContaining({ name: "octocat/world", connected: true, installationId: 42, account: "octocat", selection: "selected" }),
    ]);
    expect(sent).toEqual([]);
  });

  test("installation_repositories added records the repos disabled and starts nothing", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], { corbitsTriage: { repos: [] } });
    const res = await bridge({ db, sent })(installRequest("installation_repositories", {
      action: "added",
      installation: INSTALLATION,
      repositories_added: [{ full_name: "octocat/hello" }],
    }, "added-1"), TARGET);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(repos(db)).toEqual([expect.objectContaining({ name: "octocat/hello", connected: true, installationId: 42, enabled: false })]);
    expect(sent).toHaveLength(0);
  });

  test("removed drops listed names without mailing", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], {
      corbitsTriage: {
        repos: [
          { name: "octocat/hello", connected: true, installationId: 42 },
          { name: "octocat/keep", connected: true, installationId: 42 },
        ],
      },
    });
    const res = await bridge({ db, sent })(installRequest("installation_repositories", {
      action: "removed",
      installation: INSTALLATION,
      repositories_removed: [{ full_name: "octocat/hello" }],
    }, "removed-1"), TARGET);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(repos(db)).toEqual([expect.objectContaining({ name: "octocat/keep" })]);
    expect(sent).toHaveLength(0);
  });

  test("deleted drops rows for that installation only", async () => {
    const db = stubDb([hookRow()], {
      corbitsTriage: {
        repos: [
          { name: "octocat/hello", connected: true, installationId: 42 },
          { name: "acme/other", connected: true, installationId: 7 },
        ],
      },
    });
    await bridge({ db })(installRequest("installation", { action: "deleted", installation: INSTALLATION }, "deleted-1"), TARGET);
    expect(repos(db)).toEqual([expect.objectContaining({ name: "acme/other", installationId: 7 })]);
  });

  test("suspend disconnects that installation only", async () => {
    const db = stubDb([hookRow()], {
      corbitsTriage: {
        repos: [
          { name: "octocat/hello", connected: true, installationId: 42 },
          { name: "acme/other", connected: true, installationId: 7 },
        ],
      },
    });
    await bridge({ db })(installRequest("installation", { action: "suspend", installation: INSTALLATION }, "suspend-1"), TARGET);
    expect(repos(db)).toEqual([
      expect.objectContaining({ name: "octocat/hello", connected: false }),
      expect.objectContaining({ name: "acme/other", connected: true }),
    ]);
  });

  test("a missing tenant is 202 ignored", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], undefined, { missingTenant: true });
    const res = await bridge({ db, sent })(installRequest("installation", {
      action: "created",
      installation: INSTALLATION,
      repositories: [{ full_name: "octocat/hello" }],
    }, "missing-tenant"), TARGET);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(sent).toHaveLength(0);
  });

  test("preserves sibling config keys", async () => {
    const db = stubDb([hookRow()], {
      other: { keep: true },
      corbitsTriage: {
        confidenceFloor: 0.8,
        repos: [{ name: "octocat/hello", connected: true, installationId: 1, triageDrafts: false }],
      },
    });
    await bridge({ db })(installRequest("installation_repositories", {
      action: "added",
      installation: INSTALLATION,
      repositories_added: [{ full_name: "octocat/extra" }],
    }, "siblings-1"), TARGET);
    const config = db.tenantConfig() as {
      other: unknown;
      corbitsTriage: { confidenceFloor: number; repos: Array<{ name: string; triageDrafts?: boolean }> };
    };
    expect(config.other).toEqual({ keep: true });
    expect(config.corbitsTriage.confidenceFloor).toBe(0.8);
    expect(config.corbitsTriage.repos.find((row) => row.name === "octocat/hello")?.triageDrafts).toBe(false);
  });
});

test("installation listing mirrors GitHub", () => {
  const ns = {
    repos: [
      { name: "acme/kept", connected: true, installationId: 1 },
      { name: "acme/removed", connected: true, installationId: 1 },
      { name: "old/uninstalled", connected: true, installationId: 2 },
      { name: "paused/repo", connected: true, installationId: 3 },
      { name: "manual/repo", connected: true },
    ],
  };
  const listings = [
    { fields: { installationId: 1, account: "acme" }, suspended: false as const, names: ["acme/kept", "acme/new"] },
    { fields: { installationId: 3 }, suspended: true as const },
  ];
  const next = applyInstallationListing(ns, listings);
  expect(repoRecords(next).map((row) => row.name).sort()).toEqual(["acme/kept", "acme/new", "manual/repo", "paused/repo"]);
  expect(repoRecords(next).find((row) => row.name === "paused/repo")?.connected).toBe(false);
});

test("mailPayload mails the pack whole as `pack`, as `checkPack` only the steps a deployment built before steps runs as the policy means, and the versions it was resolved from", () => {
  const base = recommendedPack("octocat/hello");
  const score: CustomCheck = { id: "care", name: "Care", group: "pull-request", kind: "model", shape: "score", subject: "care", levels: ["poor", "fair", "good", "great"], failBelow: "good" };
  const pack: CheckPack = {
    ...base,
    custom: [score],
    actions: { ...base.actions, pass: [{ do: "approve" }, { do: "merge" }, { do: "comment", target: { body: "Hi" }, for: "first-timers" }, { do: "labels", target: { from: "rules" } }] },
  };
  const source = { repo: { id: "art_pack", version: 3 }, shared: { id: "art_shared", version: 7 } };
  const mail = mailPayload({ name: "octocat/hello" }, repoPolicy({ enabled: true }), { pack, automatic: [], source }, {});
  expect(mail.policy.source).toEqual(source);
  expect(mail.pack).toBe(pack);
  expect(mail.checkPack).toMatchObject({ schemaVersion: 1 });
  expect(mail.checkPack).not.toHaveProperty("labels");
  expect(mail.checkPack.custom).toEqual([{ id: "care", name: "Care", group: "pull-request", kind: "model", shape: "score", subject: "care", min: 7 }]);
  expect(mail.checkPack.actions).toEqual({ when: base.actions.when, pass: [{ kind: "approve", target: {} }], fail: [], unsure: [{ kind: "request-review", target: { to: "codeowners" } }] });
});

