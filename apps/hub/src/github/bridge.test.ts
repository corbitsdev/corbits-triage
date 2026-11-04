import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { emptyPack, type CheckPack } from "@corbits/triage-contracts";
import { GITHUB_HOOK_HEADERS, xHubHookMetadata } from "@corbits/common/hook-metadata";
import { applyInstallationListing, createBridgeHandler, loadBridgeHook, type BridgeDeps } from "./bridge.js";
import { MAX_BODY_BYTES } from "../read-json.js";
import { repoRecords } from "./tenant-config.js";
import { DeliveryCache } from "./dedupe.js";
import type { CoalescedEvent } from "./coalescer.js";

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

const APP_ROW = { id: "crd_app", tenantId: TENANT_ID, principalId: null, name: "github", status: "active", metadata: { appSlug: "corbits-triage" } };

function asksForName(node: unknown, name: string): boolean {
  if (node === name) return true;
  if (!node || typeof node !== "object") return false;
  const chunks = (node as { queryChunks?: unknown[]; value?: unknown }).queryChunks;
  if (Array.isArray(chunks)) return chunks.some((chunk) => asksForName(chunk, name));
  return asksForName((node as { value?: unknown }).value, name);
}

function stubDb(rows: Row[], config: unknown = CONNECTED_HELLO): StubDb {
  const box = { config };
  function tenantRows() {
    return [{ id: TENANT_ID, config: box.config }];
  }
  const tx = {
    select() {
      // Unlocked, it is the pr-triage role lookup, and the workspace has none.
      return { from() { return { where() { return Object.assign([], { async for() { return tenantRows(); } }); } }; } };
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

function packsFor(repos: string[]): BridgeDeps["readCheckPack"] {
  const packs = new Map(repos.map((repo) => [repo, rulePack(repo)]));
  return async function readCheckPack(_tenant, repo) {
    const pack = packs.get(repo);
    return pack ? { status: "ok", pack, automatic: [], source: { file: { path: ".corbits-triage.yml", sha: "art_pack-1" } } } : { status: "missing" };
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
    metadata: xHubHookMetadata("pr-triage", GITHUB_HOOK_HEADERS),
    ...overrides,
  };
}

type Sent = CoalescedEvent;

function ignoreLog(): void {}

const openHeadFor: BridgeDeps["openHeadFor"] = async function openHeadFor() {
  return async function openHead(_record, number) {
    return { headSha: `sha${number}`, draft: false };
  };
};

type Recheck = [string, string, number | null];

function bridge({ refreshed = [], ...overrides }: Partial<BridgeDeps> & { sent?: Sent[]; rechecks?: Recheck[]; refreshed?: string[] } = {}) {
  const sent = overrides.sent ?? [];
  const rechecks = overrides.rechecks ?? [];
  async function accept(input: CoalescedEvent) {
    sent.push(input);
    return "queued" as const;
  }
  async function recheckOpenPulls(tenantId: string, repo: string, except: number | null) {
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
    openHeadFor,
    recheckOpenPulls,
    async closeOutDue() {
      return false;
    },
    async retireClosed() {},
    async refreshPolicyFile(_tenantId, repo) {
      refreshed.push(repo);
      return { status: "absent" };
    },
    async startBacklog() {
      return Response.json({}, { status: 409 });
    },
    heard() {},
    repoChanged() {},
    installationChanged() {},
    ...overrides,
  });
}

describe("loadBridgeHook", () => {
  test("rejects revoked, personal and non-webhook credentials", async () => {
    expect(await loadBridgeHook(stubDb([hookRow({ status: "revoked" })]), stubCipher, HOOK_ID, undefined)).toBeUndefined();
    expect(await loadBridgeHook(stubDb([hookRow({ principalId: "prn_1" })]), stubCipher, HOOK_ID, undefined)).toBeUndefined();
    expect(await loadBridgeHook(stubDb([hookRow({ metadata: {} })]), stubCipher, HOOK_ID, undefined)).toBeUndefined();
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

  test("duplicates are 200 without redelivery", async () => {
    const sent: Sent[] = [];
    const handle = bridge({ sent });
    expect((await handle(githubRequest(prPayload, { delivery: "dup" }), TARGET)).status).toBe(202);
    const second = await handle(githubRequest(prPayload, { delivery: "dup" }), TARGET);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "duplicate" });
    expect(sent).toHaveLength(1);
  });

  test("a merge into the default branch reads the policy file again and re-checks that repository's other open pull requests", async () => {
    const sent: Sent[] = [];
    const rechecks: Recheck[] = [];
    const refreshed: string[] = [];
    const db = stubDb([hookRow()], { corbitsTriage: { repos: [{ name: "octocat/hello", connected: true, enabled: true }, { name: "octocat/other", connected: true, enabled: false }] } });
    const handle = bridge({ db, sent, rechecks, refreshed });
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
    expect(refreshed).toEqual(["octocat/hello", "octocat/other"]);
    expect(sent).toHaveLength(0);
  });

  test("a push that changes the policy file triages the open pull requests once per delivery, and a forced push alone does not", async () => {
    const started: string[] = [];
    const handle = bridge({
      async startBacklog(_tenantId, record) {
        started.push(record.name);
        return Response.json({}, { status: 503 });
      },
    });
    function push(commit: Record<string, string[]>, forced = false) {
      return JSON.stringify({ ref: "refs/heads/main", forced, repository: { full_name: "octocat/hello", default_branch: "main" }, commits: [commit] });
    }
    const deliveries: Array<[string, string, number]> = [
      [push({ added: [".corbits-triage.yml"] }), "changed", 202],
      [push({ added: [".corbits-triage.yml"] }), "changed", 200],
      [push({ modified: ["README.md"] }, true), "forced", 202],
    ];
    for (const [body, delivery, status] of deliveries) expect((await handle(githubRequest(body, { event: "push", delivery }), TARGET)).status).toBe(status);
    expect(started).toEqual(["octocat/hello"]);
  });

  test("a pull request that closes or merges goes on to its manager only where it has a comment to close out", async () => {
    const sent: Sent[] = [];
    const rechecks: Recheck[] = [];
    const asked: string[] = [];
    async function closeOutDue(_tenantId: string, pr: { source: string; repo: string; number: number }, head: string) {
      asked.push(`${pr.source} ${pr.repo}#${pr.number}@${head}`);
      return asked.length > 1;
    }
    const handle = bridge({ sent, rechecks, closeOutDue });
    const pr = JSON.parse(prPayload);
    function closed(merged: boolean) {
      return JSON.stringify({ ...pr, action: "closed", repository: { full_name: "octocat/hello", default_branch: "main" }, pull_request: { ...pr.pull_request, state: "closed", merged, base: { ref: "main" } } });
    }
    expect(await (await handle(githubRequest(closed(true), { delivery: "decided" }), TARGET)).json()).toEqual({ status: "accepted" });
    expect(sent).toHaveLength(0);
    expect((await handle(githubRequest(closed(true), { delivery: "merged" }), TARGET)).status).toBe(202);
    expect((await handle(githubRequest(closed(false), { delivery: "closed" }), TARGET)).status).toBe(202);
    expect(asked).toEqual(["github octocat/hello#7@abc", "github octocat/hello#7@abc", "github octocat/hello#7@abc"]);
    expect(sent.map((input) => [input.event, input.mail.merged])).toEqual([["merged", true], ["closed", undefined]]);
    expect(rechecks).toEqual([[TENANT_ID, "octocat/hello", 7], [TENANT_ID, "octocat/hello", 7]]);
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

  test("a disabled repo is 202 ignored", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], {
      corbitsTriage: { repos: [{ name: "octocat/hello", connected: true, enabled: false }] },
    });
    const res = await bridge({ db, sent })(githubRequest(prPayload), TARGET);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(sent).toHaveLength(0);
  });

  test("a draft is 202 ignored as its event says, and triaged once marked ready; a check run is left to its window to read", async () => {
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
    async function unread(): Promise<undefined> {
      throw new Error("read GitHub");
    }
    const handle = bridge({ db, sent, openHeadFor: unread });
    expect(await (await handle(githubRequest(draftOpened, { delivery: "d1" }), TARGET)).json()).toEqual({ status: "ignored" });
    expect(sent).toHaveLength(0);
    expect(await (await handle(githubRequest(markedReady, { delivery: "d3" }), TARGET)).json()).toEqual({ status: "queued" });
    expect(await (await handle(githubRequest(checkRun, { delivery: "d4", event: "check_run" }), TARGET)).json()).toEqual({ status: "queued" });
    expect(sent.map(({ event, headSha, draftUnread }) => [event, headSha, draftUnread])).toEqual([["ready", "abc", undefined], ["checks", "sha7", true]]);
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

  test("removed drops listed names without mailing", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], {
      corbitsTriage: {
        repos: [
          { name: "octocat/hello", connected: true, installationId: 42 },
          { name: "octocat/hello", source: "bitbucket-datacenter", connected: true },
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
    expect(repos(db)).toEqual([expect.objectContaining({ name: "octocat/hello", source: "bitbucket-datacenter" }), expect.objectContaining({ name: "octocat/keep" })]);
    expect(sent).toHaveLength(0);
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

