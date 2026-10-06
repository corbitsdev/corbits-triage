// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { checkPackName, emptyPack, repoPolicy } from "@corbits/triage-contracts";
import { createBridgeHandler, loadBridgeHook, MAX_BODY_BYTES, type BridgeDeps } from "./bridge.js";
import { DeliveryCache } from "./dedupe.js";
import { NoLiveDeploymentError } from "./deployment.js";
import { verifySignature } from "./signature.js";

const SECRET = "test-webhook-secret";
const HOOK_ID = "crd_test123";
const TENANT_ID = "tnt_test";
const TARGET = { hookId: HOOK_ID };
const CONNECTED_HELLO = { corbitsTriage: { repos: [{ name: "octocat/hello", connected: true }] } };

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
        async findFirst() {
          return rows[0];
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

function packsFor(repos: string[]): BridgeDeps["readCheckPack"] {
  const packs = new Map(repos.map((repo) => [repo, emptyPack(repo)]));
  return async function readCheckPack(_tenant, repo) {
    const pack = packs.get(repo);
    return pack ? { status: "ok", pack } : { status: "missing" };
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

type Sent = { workflow: string; payload: unknown };

function ignoreLog(): void {}

function bridge(overrides: Partial<BridgeDeps> & { sent?: Sent[] } = {}) {
  const sent = overrides.sent ?? [];
  async function recordMail(_tenant: string, workflow: string, payload: unknown) {
    sent.push({ workflow, payload });
  }
  return createBridgeHandler({
    db: stubDb([hookRow()]),
    cipher: stubCipher,
    cache: new DeliveryCache(),
    sendMail: recordMail,
    log: ignoreLog,
    readCheckPack: packsFor(["octocat/hello"]),
    ...overrides,
  });
}

/** Fails the first `failures` sends, then records. */
function flakyMail(sent: Sent[], failures: number): BridgeDeps["sendMail"] {
  let calls = 0;
  return async function sendMail(_tenant, workflow, payload) {
    calls += 1;
    if (calls <= failures) throw new Error("hub down");
    sent.push({ workflow, payload });
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
  test("forwards a valid delivery with the repo policy to the hook workflow", async () => {
    const sent: Sent[] = [];
    const res = await bridge({ sent })(githubRequest(prPayload), TARGET);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "forwarded" });
    expect(sent).toEqual([{
      workflow: "pr-triage",
      payload: expect.objectContaining({
        repo: "octocat/hello",
        prNumber: 7,
        policy: expect.objectContaining({
          cleanupMode: "human-approved",
          classificationAuthorized: true,
          checks: { draft: true, ci: true, duplicate: true, conflicts: true, reviewers: true, drift: true },
        }),
      }),
    }]);
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

  test("unactionable events are 202 ignored", async () => {
    const sent: Sent[] = [];
    const res = await bridge({ sent })(githubRequest(JSON.stringify({ zen: "hi" }), { event: "ping" }), TARGET);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(sent).toHaveLength(0);
  });

  test("unconfigured repositories are 202 ignored", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], { corbitsTriage: { repos: [{ name: "octocat/other", connected: true }] } });
    const res = await bridge({ db, sent })(githubRequest(prPayload), TARGET);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(sent).toHaveLength(0);
  });

  test("paused classification accepts without mailing", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], {
      corbitsTriage: { repos: [{ name: "octocat/hello", connected: true, classificationAuthorized: false }] },
    });
    const res = await bridge({ db, sent })(githubRequest(prPayload), TARGET);
    expect(await res.json()).toEqual({ status: "paused" });
    expect(sent).toHaveLength(0);
  });

  test("a repo without a check pack is needs-setup and does not mail", async () => {
    const sent: Sent[] = [];
    const res = await bridge({ sent, readCheckPack: packsFor([]) })(githubRequest(prPayload), TARGET);
    expect(await res.json()).toEqual({ status: "needs-setup" });
    expect(sent).toHaveLength(0);
  });

  test("no live deployment is 503 so GitHub retries", async () => {
    async function noDeployment(): Promise<never> {
      throw new NoLiveDeploymentError("pr-triage");
    }
    const res = await bridge({ sendMail: noDeployment })(githubRequest(prPayload), TARGET);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "stale_deployment" });
  });

  test("a failed delivery releases the id for retry", async () => {
    const sent: Sent[] = [];
    const handle = bridge({ sendMail: flakyMail(sent, 1) });
    expect((await handle(githubRequest(prPayload, { delivery: "retry" }), TARGET)).status).toBe(502);
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

function backlogMail(repo: string): Sent {
  return {
    workflow: "pr-triage-historical",
    payload: {
      kind: "backlog",
      repo,
      policy: { ...repoPolicy(undefined), checkPack: { name: checkPackName(repo) } },
      checkPack: emptyPack(repo),
    },
  };
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
          cleanupMode: "automated",
          classificationAuthorized: false,
          checks: { draft: false, ci: true, duplicate: true, conflicts: true, reviewers: true, drift: true },
        }],
      },
    });
    const res = await bridge({ db, sent, readCheckPack: packsFor([]) })(installRequest("installation", {
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
        cleanupMode: "automated",
        classificationAuthorized: false,
        checks: expect.objectContaining({ draft: false }),
      }),
      expect.objectContaining({ name: "octocat/world", connected: true, installationId: 42, account: "octocat", selection: "selected" }),
    ]);
    expect(sent).toEqual([]);
  });

  test("created mails backlog only for added repos that have a check pack", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], { corbitsTriage: { repos: [] } });
    const res = await bridge({ db, sent, readCheckPack: packsFor(["octocat/world"]) })(installRequest("installation", {
      action: "created",
      installation: INSTALLATION,
      repositories: [{ full_name: "octocat/hello" }, { full_name: "octocat/world" }],
    }, "created-pack"), TARGET);
    expect(await res.json()).toEqual({ status: "forwarded" });
    expect(sent).toEqual([backlogMail("octocat/world")]);
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

  test("preserves sibling config keys and succeeded backlog syncs", async () => {
    const db = stubDb([hookRow()], {
      other: { keep: true },
      corbitsTriage: {
        confidenceFloor: 0.8,
        backlogSync: { "octocat/hello": { status: "succeeded", operationId: "op-1" } },
        repos: [{ name: "octocat/hello", connected: true, installationId: 1, cleanupMode: "automated" }],
      },
    });
    await bridge({ db, readCheckPack: packsFor([]) })(installRequest("installation_repositories", {
      action: "added",
      installation: INSTALLATION,
      repositories_added: [{ full_name: "octocat/extra" }],
    }, "siblings-1"), TARGET);
    const config = db.tenantConfig() as {
      other: unknown;
      corbitsTriage: { confidenceFloor: number; backlogSync: unknown; repos: Array<{ name: string; cleanupMode?: string }> };
    };
    expect(config.other).toEqual({ keep: true });
    expect(config.corbitsTriage.confidenceFloor).toBe(0.8);
    expect(config.corbitsTriage.backlogSync).toEqual({
      "octocat/hello": { status: "succeeded", operationId: "op-1" },
      "octocat/extra": { status: "pending" },
    });
    expect(config.corbitsTriage.repos.find((row) => row.name === "octocat/hello")?.cleanupMode).toBe("automated");
  });

  test("retries backlog mail after a failed send on created", async () => {
    const sent: Sent[] = [];
    const db = stubDb([hookRow()], { corbitsTriage: { repos: [] } });
    const handle = bridge({ db, sendMail: flakyMail(sent, 1) });
    const body = { action: "created", installation: INSTALLATION, repositories: [{ full_name: "octocat/hello" }] };
    expect((await handle(installRequest("installation", body, "retry-created"), TARGET)).status).toBe(502);
    const retry = await handle(installRequest("installation", body, "retry-created"), TARGET);
    expect(await retry.json()).toEqual({ status: "forwarded" });
    expect(sent).toEqual([backlogMail("octocat/hello")]);
  });
});
