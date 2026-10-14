import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { emptyPack } from "@corbits/triage-contracts";
import type { CoalescedEvent } from "../github/coalescer.js";
import { DeliveryCache } from "../github/dedupe.js";
import { createProviderHookApp } from "../provider-hooks/app.js";
import { createProviderHookHandler, type ProviderHookDeps } from "../provider-hooks/intake.js";

const SECRET = "bitbucket-secret";
const TENANT_ID = "tnt_test";
const REPOS = [
  { name: "TRI/widgets", source: "bitbucket", connected: true, enabled: true },
  { name: "TRI/gadgets", connected: true, enabled: true },
];
const HOOK_ROW = {
  id: "crd_bitbucket",
  tenantId: TENANT_ID,
  principalId: null,
  name: "bitbucket-hook",
  status: "active",
  secret: "sealed",
  metadata: { webhook: { verify: "standard-webhooks", workflow: "pr-triage" } },
};

const repository = { slug: "widgets", project: { key: "TRI" } };

function prEvent(eventKey: string, slug = "widgets") {
  const repo = { ...repository, slug };
  return JSON.stringify({
    eventKey,
    actor: { slug: "rev" },
    pullRequest: {
      id: 1,
      title: "Add subtract",
      description: "Adds subtract next to add.",
      state: eventKey === "pr:merged" ? "MERGED" : "OPEN",
      draft: false,
      fromRef: { latestCommit: "3e1552b0", repository: repo },
      toRef: { displayId: "main", repository: repo },
      author: { user: { slug: "admin" } },
    },
  });
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function hookRequest(body: string, eventKey: string, init: { delivery?: string; signature?: string } = {}): Request {
  return new Request(`https://hub.example/api/hooks/bitbucket/${TENANT_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-event-key": eventKey, "x-request-id": init.delivery ?? "req-1", "x-hub-signature": init.signature ?? sign(body) },
    body,
  });
}

function harness(overrides: Partial<ProviderHookDeps> = {}) {
  const accepted: CoalescedEvent[] = [];
  const rechecked: Array<[string, number]> = [];
  const synced: string[] = [];
  const deps: ProviderHookDeps = {
    db: {
      query: {
        credential: { async findFirst() { return HOOK_ROW; } },
        tenant: { async findFirst() { return { id: TENANT_ID, config: { corbitsTriage: { repos: REPOS } } }; } },
      },
    } as never,
    cipher: { async decrypt() { return SECRET; } } as never,
    cache: new DeliveryCache(),
    coalescer: {
      async accept(input) {
        accepted.push(input);
        return "queued";
      },
    },
    log() {},
    async readCheckPack(_tenant, repo) {
      return { status: "ok", pack: emptyPack(repo), automatic: [], source: { repo: { id: "art_pack", version: 1 } } };
    },
    async recheckOpenPulls(_tenant, repo, except) {
      rechecked.push([repo, except]);
      return 2;
    },
    async syncPolicyFile(_tenant, repo) {
      synced.push(repo);
      return { status: "unchanged", sha: "abc" };
    },
    ...overrides,
  };
  const app = createProviderHookApp(createProviderHookHandler(deps));
  return { accepted, rechecked, synced, send: (req: Request) => app.fetch(req) };
}

describe("POST /api/hooks/bitbucket/:tenantId", () => {
  test("a signed pull request event is queued once for the Bitbucket repository record", async () => {
    const h = harness();
    const body = prEvent("pr:opened");
    const first = await h.send(hookRequest(body, "pr:opened"));
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "queued" });
    const again = await h.send(hookRequest(body, "pr:opened"));
    expect(await again.json()).toEqual({ status: "duplicate" });
    expect(h.accepted).toHaveLength(1);
    expect(h.accepted[0]).toMatchObject({ workflow: "pr-triage", number: 1, headSha: "3e1552b0", event: "opened", record: { name: "TRI/widgets", source: "bitbucket" } });
  });

  test("a bad signature is 401 and a repository with no Bitbucket record is 404", async () => {
    const h = harness();
    expect((await h.send(hookRequest(prEvent("pr:opened"), "pr:opened", { signature: "sha256=00" }))).status).toBe(401);
    expect((await h.send(hookRequest(prEvent("pr:opened", "gadgets"), "pr:opened", { delivery: "req-2" }))).status).toBe(404);
    expect(h.accepted).toHaveLength(0);
  });

  test("a failed queue write is 500 and the redelivery is accepted", async () => {
    let fail = true;
    const h = harness({
      coalescer: {
        async accept() {
          if (fail) throw new Error("db down");
          return "queued";
        },
      },
    });
    const body = prEvent("pr:from_ref_updated");
    expect((await h.send(hookRequest(body, "pr:from_ref_updated"))).status).toBe(500);
    fail = false;
    expect(await (await h.send(hookRequest(body, "pr:from_ref_updated"))).json()).toEqual({ status: "queued" });
  });

  test("a merge rechecks the other open pull requests and a branch update syncs the policy file", async () => {
    const h = harness();
    expect((await h.send(hookRequest(prEvent("pr:merged"), "pr:merged"))).status).toBe(202);
    const refs = JSON.stringify({ eventKey: "repo:refs_changed", repository, changes: [{ ref: { id: "refs/heads/main", type: "BRANCH" }, type: "UPDATE" }] });
    expect((await h.send(hookRequest(refs, "repo:refs_changed", { delivery: "req-3" }))).status).toBe(202);
    expect(h.rechecked).toEqual([["TRI/widgets", 1]]);
    expect(h.synced).toEqual(["TRI/widgets"]);
  });
});
