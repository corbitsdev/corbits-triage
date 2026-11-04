import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { ensureWorkspace, projectQueue, saveRepoSettings, type Membership, type PullTriage, type PullVerdict } from "./hub-api.ts";

function verdict(runId: string, state: string, detail: Record<string, unknown> | null, fields: Partial<PullVerdict> = {}): PullVerdict {
  return {
    runId, at: "2026-10-01T01:00:00.000Z", headSha: "abc", verdict: "unsure", settled: true, state, actor: "maintainer", humanGated: false,
    degraded: null, commented: false, checks: [], detail, ...fields,
  };
}

function pull(number: number, fields: Partial<PullTriage> = {}): PullTriage {
  return { repo: "acme/widgets", number, source: "github", activityAt: null, verdict: null, run: null, ...fields };
}

describe("projectQueue from the hub's verdicts", () => {
  const pr = (number: number) => ({ number, title: `PR ${number}`, author: "ada", draft: false, sha: "def", updatedAt: "2026-10-01T00:00:00.000Z", labels: [] });
  const openPulls = { repos: [{ repo: "acme/widgets", prs: [pr(8), pr(9), pr(10)] }] };

  test("a verdict shows its own fields and the facts it read; one recorded before the hub kept them shows its state, checks and GitHub's title", () => {
    const output = { kind: "score", score: 20, passAt: 60, items: ["Alpha — src/alpha.ts"] };
    const check = { check: "focused", kind: "model", result: "fail", reason: "mixes unrelated changes", evidence: ["Alpha — src/alpha.ts"], output };
    const detail = {
      headSha: "abc123", priority: "P1", verdict: "fail", score: 0.1, reasons: ["mixes unrelated changes: Alpha — src/alpha.ts"], reason: "Mixes two changes.", evidence: ["Mixes two changes."], checks: [check], labels: ["triage:split"], feedback: "Please split this.",
      facts: { title: "Add widgets", author: "ann", draft: false, mergeable: true, checks: "pending" },
    };
    const items = projectQueue([pull(8, { verdict: verdict("run-8", "needs-author-update", detail, { verdict: "fail", commented: true }) }), pull(9, { verdict: verdict("run-9", "needs-decision", null, { humanGated: true, checks: [{ check: "ci-green", result: "fail" }] }) })], [], openPulls);
    expect(items).toEqual([
      expect.objectContaining({
        key: "acme/widgets#8", state: "needs-author-update", priority: "P1", verdict: "fail", score: 0.1, reasons: ["mixes unrelated changes: Alpha — src/alpha.ts"], evidence: ["Mixes two changes."], checks: [{ ...check, gate: false }],
        labels: ["triage:split"], comment: "Please split this.", verdictSha: "abc123", posted: true, title: "Add widgets", author: "ann", mergeable: true, ci: "pending", sha: "abc", runId: "run-8",
      }),
      expect.objectContaining({
        key: "acme/widgets#9", state: "needs-decision", needsHuman: true, verdictSha: null, verdict: "unsure", score: null, reasons: [], comment: null, title: "PR 9", author: "ada",
        checks: [{ check: "ci-green", kind: null, result: "fail", reason: null, evidence: [], output: null, gate: false }],
      }),
      expect.objectContaining({ key: "acme/widgets#10", state: "new" }),
    ]);
  });

});

const membership = (tenantSlug: string, status: Membership["status"]): Membership => ({
  principalId: `p-${tenantSlug}`,
  tenantId: `t-${tenantSlug}`,
  tenantName: tenantSlug,
  tenantSlug,
  kind: "user",
  status,
  roles: [],
});

function membershipHub(memberships: Membership[]) {
  const created: unknown[] = [];
  const transport: Transport = {
    fetch: async (method, path, body) => {
      if (method === "GET" && path === "/api/me") return { id: "user", name: "ada", email: "ada@example.com" } as never;
      if (method === "GET" && path.startsWith("/api/me/principals")) return { data: memberships, nextCursor: null } as never;
      if (method === "POST" && path === "/api/tenants") {
        created.push(body);
        memberships.unshift(membership("corbits-triage-ada-user", "active"));
        return {} as never;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    subscribe: () => () => {},
  };
  return { created, memberships, transport };
}

describe("workspace resolution", () => {
  test("opens the team workspace a member belongs to, without creating one", async () => {
    const hub = membershipHub([membership("corbits-triage-team", "active")]);
    expect(await ensureWorkspace(hub.transport, null)).toMatchObject({ kind: "member", workspace: { tenantId: "t-corbits-triage-team", principalId: "p-corbits-triage-team" } });
    expect(hub.created).toEqual([]);
  });

  test("an invitee gets their pending invitations, not a new workspace", async () => {
    const hub = membershipHub([membership("corbits-triage-team", "invited"), membership("other-app", "active")]);
    expect(await ensureWorkspace(hub.transport, null)).toEqual({ kind: "invited", invitations: [{ tenantId: "t-corbits-triage-team", name: "corbits-triage-team", slug: "corbits-triage-team" }] });
    expect(hub.created).toEqual([]);
  });

  test("a user with no triage membership or invitation gets a workspace of their own, named for them", async () => {
    const hub = membershipHub([membership("corbits-triage-team", "suspended")]);
    expect(await ensureWorkspace(hub.transport, null)).toMatchObject({ kind: "member", workspace: { tenantId: "t-corbits-triage-ada-user" } });
    expect(hub.created).toEqual([{ name: "ada's workspace", slug: "corbits-triage-ada-user" }]);
  });

  test("a stray workspace of the user's own does not hide the team's, even when newer or sorted first", async () => {
    const hub = membershipHub([membership("corbits-triage-ada-user", "active"), membership("corbits-triage-team", "active")]);
    expect(await ensureWorkspace(hub.transport, "t-gone")).toMatchObject({ kind: "member", workspace: { tenantId: "t-corbits-triage-team" } });
  });

});

describe("repository policy config", () => {
  test("saveRepoSettings PATCHes only that repo and spreads other fields", async () => {
    let config: Record<string, unknown> = {
      other: 1,
      corbitsTriage: {
        confidenceFloor: 0.7,
        repos: [
          { name: "acme/one", connected: true, installationId: 9 },
          { name: "acme/two", connected: true, installationId: 3 },
        ],
      },
    };
    const transport: Transport = {
      fetch: async (method, path, body) => {
        if (method === "GET" && path === "/api/tenants/tenant") {
          return { id: "tenant", name: "Tenant", slug: "tenant", config } as never;
        }
        if (method === "PATCH" && path === "/api/tenants/tenant") {
          config = (body as { config: Record<string, unknown> }).config;
          return undefined as never;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
      subscribe: () => () => {},
    };

    await saveRepoSettings(transport, "tenant", "acme/one", "github", {
      enabled: false,
    });

    expect(config.other).toBe(1);
    const ns = config.corbitsTriage as { confidenceFloor: number; repos: Array<Record<string, unknown>> };
    expect(ns.confidenceFloor).toBe(0.7);
    expect(ns.repos[0]).toMatchObject({
      name: "acme/one",
      connected: true,
      installationId: 9,
      enabled: false,
    });
    expect(ns.repos[0]).not.toHaveProperty("checkPack");
    expect(ns.repos[1]).toEqual({ name: "acme/two", connected: true, installationId: 3 });
  });

  test("a repository with the same name on both hosts is saved on its own host only", async () => {
    const github = { name: "acme/api", connected: true, enabled: false, installationId: 9 };
    const bitbucket = { name: "acme/api", connected: true, enabled: true, source: "bitbucket-datacenter" };
    let config: Record<string, unknown> = { corbitsTriage: { repos: [github, bitbucket] } };
    const transport: Transport = {
      fetch: async (method, path, body) => {
        if (path !== "/api/tenants/tenant") throw new Error(`unexpected ${method} ${path}`);
        if (method === "GET") return { id: "tenant", name: "Tenant", slug: "tenant", config } as never;
        config = (body as { config: Record<string, unknown> }).config;
        return undefined as never;
      },
      subscribe: () => () => {},
    };
    function repos() {
      return (config.corbitsTriage as { repos: unknown[] }).repos;
    }

    await saveRepoSettings(transport, "tenant", "acme/api", "github", { enabled: true });
    expect(repos()).toEqual([{ ...github, enabled: true }, bitbucket]);

    await saveRepoSettings(transport, "tenant", "acme/api", "bitbucket-datacenter", { enabled: false });
    expect(repos()).toEqual([{ ...github, enabled: true }, { ...bitbucket, enabled: false }]);
  });
});
