import { describe, expect, test } from "bun:test";
import { ApiError, type Transport } from "@intx/hub-client";
import { defaultActions, recommendedPack, stockTriggerMail } from "@corbits/triage-contracts";
import {
  createGrant,
  deleteGrant,
  ensureWorkspace,
  configureGithubApp,
  ensureHookCredential,
  githubAppSecret,
  GITHUB_HOOK_CREDENTIAL_NAME,
  portalConnected,
  previewPull,
  projectQueue,
  reposFromConfig,
  removeRepository,
  saveInference,
  saveRepoSettings,
  triagePullRequest,
  untilDeploymentReady,
  patchAppConfig,
  type HubApproval,
  type Membership,
  type PortalSnapshot,
  type PullTriage,
  type PullVerdict,
  type RunLog,
} from "./hub-api.ts";

const decidedLog: RunLog = {
  runId: "run-triage",
  anchorRunId: "run-triage",
  events: [{ seq: 0, type: "RunStarted", body: { trigger: { payload: stockTriggerMail({ kind: "pr", repo: "acme/widgets", prNumber: 8 }) } } }],
};

/** A verdict as the hub's triage-verdicts route answers it. */
function verdict(runId: string, state: string, detail: Record<string, unknown> | null, fields: Partial<PullVerdict> = {}): PullVerdict {
  return {
    runId, at: "2026-10-01T01:00:00.000Z", headSha: "abc", verdict: "unsure", settled: true, state, actor: "maintainer", humanGated: false,
    degraded: null, commented: false, checks: [], detail, ...fields,
  };
}

function pull(number: number, fields: Partial<PullTriage> = {}): PullTriage {
  return { repo: "acme/widgets", number, activityAt: null, verdict: null, run: null, ...fields };
}

const decided = pull(8, {
  verdict: verdict("run-triage", "needs-decision", { labels: ["needs-decision"], feedback: "Needs a decision.", nextAction: "Decide" }, { humanGated: true }),
});

const approval = (id: string): HubApproval => ({
  id,
  tenantId: "tenant",
  runId: "run-triage",
  anchorRunId: "run-triage",
  agentAddress: "run-triage",
  status: "pending",
  scope: null,
  toolDefinition: { name: "github_mirror" },
  toolArguments: { repo: "acme/widgets", number: 8, labels: ["needs-decision"], comment: "Needs a decision." },
  correlationId: id,
  timeoutAt: null,
  resolvedAt: null,
  createdAt: "2026-03-10T00:00:00.000Z",
  updatedAt: "2026-03-10T00:00:00.000Z",
});

const snapshot = (): PortalSnapshot => ({
  workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
  tenantName: "Acme",
  workspaces: [],
  invitations: [],
  repos: [],
  credentials: [],
  denied: { repos: false, credentials: false },
});

const queue = (approvals: HubApproval[], pulls: PullTriage[] = [decided], openPulls?: Parameters<typeof projectQueue>[2]) =>
  projectQueue(pulls, approvals, openPulls);

describe("approval projection", () => {
  test("a pending mirror approval needs a human", () => {
    const [item] = queue([approval("mirror")]);
    expect(item).toMatchObject({ pendingApprovalId: "mirror", needsHuman: true });
  });

  test("a pull request that is no longer open is closed and needs no human", () => {
    const [item] = queue([approval("mirror")], [decided], { repos: [{ repo: "acme/widgets", prs: [] }] });
    expect(item).toMatchObject({ closed: true, needsHuman: false });
  });

  test("keeps the canonical pull request href when an approval is pending", () => {
    const [item] = queue([approval("mirror")]);
    expect(item?.href).toBe("/triage/pr/acme/widgets/8");
    expect(item?.runId).toBe("run-triage");
  });
});

describe("check rows", () => {
  test("a verdict's rows for rules since removed are left out, and rows under a renamed rule's old id read as the new one", () => {
    const rows = [{ check: "duplicate", kind: "machine", result: "pass", evidence: [] }, { check: "ci", kind: "machine", result: "pass", evidence: [] }];
    const recorded = [{ check: "drift", result: "pass" }, { check: "ci", result: "pass" }];
    const items = projectQueue([pull(8, { verdict: verdict("run-8", "ready", { checks: rows }) }), pull(9, { verdict: verdict("run-9", "ready", null, { checks: recorded }) })], [], undefined);
    expect(items.map((item) => item.checks.map((c) => c.check))).toEqual([["ci-green"], ["ci-green"]]);
  });

  test("an old size row reads as the limit its evidence names, or as both limits without evidence", () => {
    const rows = [{ check: "size", kind: "machine", result: "fail", evidence: ["40 files (max 30)"] }];
    const recorded = [{ check: "size", result: "pass" }];
    const items = projectQueue([pull(8, { verdict: verdict("run-8", "ready", { checks: rows }) }), pull(9, { verdict: verdict("run-9", "ready", null, { checks: recorded }) })], [], undefined);
    expect(items.map((item) => item.checks.map((c) => [c.check, c.result, c.evidence]))).toEqual([
      [["max-files-changed", "fail", ["40 files (max 30)"]]],
      [["max-files-changed", "pass", []], ["max-lines-changed", "pass", []]],
    ]);
  });
});

describe("needs-human queue sources", () => {
  test("human-gated PRs remain projected while an approval is pending", () => {
    const approvals = [approval("mirror", false)];
    expect(queue(approvals).filter((item) => item.needsHuman).map((item) => item.key)).toEqual(["acme/widgets#8"]);
  });
});

describe("All-view queue sources", () => {
  test("does not surface listener deployments as pull requests when the project queue is empty", () => {
    expect(projectQueue([], [], undefined)).toEqual([]);
  });
});

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

  test("a pull request's run in flight, ended early or not read yet shows, with or without a previous verdict", () => {
    const run = (status: "running" | "stuck" | "failed") => ({ runId: `run-${status}`, startedAt: "2026-10-01T01:30:00.000Z", status });
    const pulls = [
      pull(8, { verdict: decided.verdict, run: run("running"), activityAt: "2026-10-01T01:30:00.000Z" }),
      pull(9, { run: run("stuck") }),
      pull(10, { run: run("failed") }),
      pull(11, { verdict: decided.verdict, run: { status: "unknown" } }),
    ];
    expect(projectQueue(pulls, [], openPulls).map(({ key, state, running, failure, activityAt }) => ({ key, state, running, failure, activityAt }))).toEqual([
      { key: "acme/widgets#8", state: "needs-decision", running: true, failure: null, activityAt: "2026-10-01T01:30:00.000Z" },
      // Until the hub read the live logs since it started, a run may be going, so writes wait as for one that is.
      { key: "acme/widgets#11", state: "needs-decision", running: true, failure: null, activityAt: null },
      { key: "acme/widgets#9", state: "new", running: false, failure: "stuck", activityAt: null },
      { key: "acme/widgets#10", state: "new", running: false, failure: "failed", activityAt: null },
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

/** Memberships newest first, as stock /api/me/principals lists them. */
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

  test("a membership activated on a later poll joins the list without switching the open workspace", async () => {
    const team = membership("corbits-triage-team", "invited");
    const hub = membershipHub([membership("corbits-triage-ada-user", "active"), team]);
    const first = await ensureWorkspace(hub.transport, null);
    if (first.kind !== "member") throw new Error("expected a member");
    expect(first.workspace.tenantId).toBe("t-corbits-triage-ada-user");
    team.status = "active";
    const later = await ensureWorkspace(hub.transport, first.workspace.tenantId);
    expect(later).toMatchObject({ kind: "member", workspace: { tenantId: "t-corbits-triage-ada-user" }, invitations: [] });
    if (later.kind !== "member") throw new Error("expected a member");
    expect(later.workspaces.map((option) => option.tenantId)).toEqual(["t-corbits-triage-ada-user", "t-corbits-triage-team"]);
  });
});

describe("workspace GitHub App and repository lifecycle", () => {
  test("stores one repo-free workspace credential and completes App setup without repositories", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: Transport = {
      fetch: async (method, path, body) => {
        calls.push({ method, path, body });
        if (method === "GET" && path.includes("/providers")) {
          return { data: [{ id: "provider", name: "github", plugin: "http", apiBaseUrl: "https://api.github.com" }], nextCursor: null } as never;
        }
        if (method === "POST" && path.endsWith("/credentials")) return { id: "credential" } as never;
        if (method === "DELETE" && path.endsWith("/credentials/legacy-api")) return undefined as never;
        throw new Error(`unexpected ${method} ${path}`);
      },
      subscribe: () => () => {},
    };
    const secret = githubAppSecret({ appId: "123", privateKey: "pem" });

    await configureGithubApp(transport, "tenant", secret, ["legacy-api"]);

    expect(JSON.parse(secret)).toEqual({ appId: "123", privateKey: "pem" });
    expect(calls.find((call) => call.method === "POST" && call.path.endsWith("/credentials"))).toMatchObject({
      method: "POST",
      path: "/api/tenants/tenant/credentials",
      body: { name: "github", secret },
    });
    expect(calls.at(-1)).toEqual({
      method: "DELETE",
      path: "/api/tenants/tenant/credentials/legacy-api",
      body: undefined,
    });
    const configured = snapshot();
    configured.credentials = [{ id: "credential", tenantId: "tenant", name: "github", type: "other", status: "active", providerId: "provider", createdAt: "2026-03-10T00:00:00.000Z", updatedAt: "2026-03-10T00:00:00.000Z" }];
    expect(portalConnected(configured)).toBe(true);
  });

  test("converges one app-level hook for every repository", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: Transport = {
      fetch: async (method, path, body) => {
        calls.push({ method, path, body });
        if (method === "GET" && path.includes("/providers")) {
          return { data: [{ id: "provider", name: "github", plugin: "http", apiBaseUrl: "https://api.github.com" }], nextCursor: null } as never;
        }
        if (method === "POST" && path.endsWith("/credentials")) return { id: "shared-hook" } as never;
        if (method === "GET" && path.endsWith(`/resolve/${GITHUB_HOOK_CREDENTIAL_NAME}`)) return { id: "shared-hook" } as never;
        if (method === "GET" && path.endsWith("/credentials/shared-hook")) {
          return { id: "shared-hook", name: GITHUB_HOOK_CREDENTIAL_NAME, status: "active", providerId: "provider" } as never;
        }
        if (method === "PATCH") return undefined as never;
        throw new Error(`unexpected ${method} ${path}`);
      },
      subscribe: () => () => {},
    };

    expect(await ensureHookCredential(transport, "tenant", "secret-one")).toBe("shared-hook");
    expect(await ensureHookCredential(transport, "tenant", "secret-two")).toBe("shared-hook");

    const writes = calls.filter((call) => call.method === "POST" && call.path.endsWith("/credentials"));
    expect(writes).toHaveLength(2);
    expect(writes.every((call) => (call.body as { name?: string }).name === "github-hook")).toBe(true);
    expect(calls.some((call) => JSON.stringify(call.body ?? null).includes("github-hook:"))).toBe(false);
  });

  test("removes repository config without touching the shared hook", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: Transport = {
      fetch: async (method, path, body) => {
        calls.push({ method, path, body });
        if (method === "GET" && path === "/api/tenants/tenant") {
          return { id: "tenant", config: { corbitsTriage: { repos: [{ name: "acme/one", connected: true }, { name: "acme/two", connected: true }] } } } as never;
        }
        if (method === "PATCH" || method === "DELETE") return undefined as never;
        throw new Error(`unexpected ${method} ${path}`);
      },
      subscribe: () => () => {},
    };

    await removeRepository(transport, "tenant", "acme/one");

    expect(calls).toEqual([
      { method: "GET", path: "/api/tenants/tenant", body: undefined },
      {
        method: "PATCH",
        path: "/api/tenants/tenant",
        body: { config: { corbitsTriage: { rev: 0, repos: [{ name: "acme/two", connected: true }] } } },
      },
    ]);
  });

  test("saves inference through stock provider and credential routes", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: Transport = {
      fetch: async (method, path, body) => {
        calls.push({ method, path, body });
        if (method === "GET" && path.includes("/catalog/")) return { data: [], nextCursor: null } as never;
        if (method === "POST" && path.endsWith("/catalog/providers")) return { id: "mpv-inference" } as never;
        if (method === "POST" && path.endsWith("/catalog/models")) return { id: "mdl-inference" } as never;
        if (method === "POST" && path.endsWith("/catalog/offerings")) return { id: "mof-inference" } as never;
        if (method === "GET" && path.includes("/providers")) return { data: [], nextCursor: null } as never;
        if (method === "POST" && path.endsWith("/providers")) {
          return { id: "provider-inference", name: "corbits-system-one", plugin: "corbits-system-one" } as never;
        }
        if (method === "POST" && path.endsWith("/credentials")) return { id: "crd-inference" } as never;
        if (method === "GET" && path === "/api/tenants/tenant") {
          return { id: "tenant", name: "Acme", slug: "acme", config: {} } as never;
        }
        if (method === "PATCH" && path === "/api/tenants/tenant") return undefined as never;
        throw new Error(`unexpected ${method} ${path}`);
      },
      subscribe: () => () => {},
    };

    await saveInference(transport, "tenant", {
      endpoint: "https://inference.example/v1",
      model: "triage-large",
      secret: "sk-test",
    });

    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/tenants/tenant/providers",
      body: { name: "corbits-system-one", plugin: "corbits-system-one", apiBaseUrl: "https://inference.example/v1" },
    });
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/tenants/tenant/catalog/models",
      body: { canonicalName: "decision" },
    });
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/tenants/tenant/catalog/offerings",
      body: {
        modelId: "mdl-inference",
        providerId: "mpv-inference",
        priority: 0,
        quirks: { model: "triage-large" },
      },
    });
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/tenants/tenant/credentials",
      body: expect.objectContaining({
        providerId: "provider-inference",
        name: "corbits-system-one",
        type: "api_key",
        secret: "sk-test",
      }),
    });
    const configPatch = calls.find((call) => call.method === "PATCH" && call.path === "/api/tenants/tenant");
    expect(configPatch?.body).toMatchObject({
      config: { corbitsTriage: { inference: { endpoint: "https://inference.example/v1", model: "triage-large" } } },
    });
  });
});

describe("patchAppConfig CAS", () => {
  test("retries 409 then PATCHes the observed rev", async () => {
    let gets = 0;
    const patches: unknown[] = [];
    const transport: Transport = {
      fetch: async (method, path, body) => {
        if (method === "GET" && path === "/api/tenants/tenant") {
          gets += 1;
          return {
            id: "tenant",
            name: "Tenant",
            slug: "tenant",
            config: { other: 1, corbitsTriage: { rev: gets, repos: [{ name: "acme/one", connected: true }] } },
          } as never;
        }
        if (method === "PATCH" && path === "/api/tenants/tenant") {
          patches.push(body);
          const rev = (body as { config: { corbitsTriage: { rev?: number } } }).config.corbitsTriage.rev;
          if (rev !== 2) throw new ApiError(409, "config_conflict", "config_conflict");
          return undefined as never;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
      subscribe: () => () => {},
    };

    await patchAppConfig(transport, "tenant", (current) => ({
      ...current,
      repos: [{ name: "acme/two", connected: true }],
    }));

    expect(gets).toBe(2);
    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({ config: { corbitsTriage: { rev: 1 } } });
    expect(patches[1]).toEqual({
      config: {
        other: 1,
        corbitsTriage: { rev: 2, repos: [{ name: "acme/two", connected: true }] },
      },
    });
  });

  test("gives up after 8 conflicts", async () => {
    let patches = 0;
    const transport: Transport = {
      fetch: async (method, path) => {
        if (method === "GET" && path === "/api/tenants/tenant") {
          return { id: "tenant", config: { corbitsTriage: { rev: 1 } } } as never;
        }
        if (method === "PATCH") {
          patches += 1;
          throw new ApiError(409, "config_conflict", "config_conflict");
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
      subscribe: () => () => {},
    };
    await expect(patchAppConfig(transport, "tenant", (current) => current)).rejects.toBeInstanceOf(ApiError);
    expect(patches).toBe(8);
  });
});

describe("access grant transport", () => {
  test("createGrant posts an allow grant with origin role, never system", async () => {
    const posted: unknown[] = [];
    const transport: Transport = {
      fetch: async (method, path, body) => {
        posted.push({ method, path, body });
        return { id: "grn_2" } as never;
      },
      subscribe: () => () => {},
    };
    await createGrant(transport, "tenant", {
      roleId: "rol_owner",
      resource: "grant:*",
      action: "manage",
    });
    expect(posted).toEqual([
      {
        method: "POST",
        path: "/api/tenants/tenant/grants",
        body: {
          roleId: "rol_owner",
          resource: "grant:*",
          action: "manage",
          effect: "allow",
          origin: "role",
        },
      },
    ]);
  });

  test("deleteGrant does not call the hub for system origin", async () => {
    let called = false;
    const transport: Transport = {
      fetch: async () => {
        called = true;
        return undefined as never;
      },
      subscribe: () => () => {},
    };
    await expect(deleteGrant(transport, "tenant", { id: "grn_sys", origin: "system" })).rejects.toThrow(
      "This built-in rule cannot be removed.",
    );
    expect(called).toBe(false);
  });

  test("deleteGrant revokes a creator grant", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const transport: Transport = {
      fetch: async (method, path) => {
        calls.push({ method, path });
        return undefined as never;
      },
      subscribe: () => () => {},
    };
    await deleteGrant(transport, "tenant", { id: "grn_user", origin: "creator" });
    expect(calls).toEqual([{ method: "DELETE", path: "/api/tenants/tenant/grants/grn_user" }]);
  });
});

describe("repository policy config", () => {
  test("reposFromConfig defaults missing policy fields to the defaults", () => {
    expect(reposFromConfig({
      corbitsTriage: { repos: [{ name: "acme/widgets", connected: true }] },
    })).toEqual([expect.objectContaining({
      name: "acme/widgets",
      connected: true,
      enabled: false,
      checks: {
        ci: true,
        conflicts: true,
      },
    })]);
  });

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

    await saveRepoSettings(transport, "tenant", "acme/one", {
      enabled: false,
    }, null);

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
});

describe("deployment not ready", () => {
  function notReady() {
    return new ApiError(409, "deployment_not_ready", "The workflow deployment is still starting.");
  }

  function harness(answers: ApiError[]) {
    const posted: string[] = [];
    const waits: string[] = [];
    const slept: number[] = [];
    function unsubscribe() {}
    function subscribe() {
      return unsubscribe;
    }
    const transport: Transport = {
      async fetch(method, path) {
        posted.push(`${method} ${path}`);
        const refused = answers.shift();
        if (refused) throw refused;
        return { status: "queued", headSha: "sha1" } as never;
      },
      subscribe,
    };
    async function request() {
      return triagePullRequest(transport, "tenant", "acme/widgets", 1);
    }
    function onWait() {
      waits.push("waiting");
    }
    async function sleep(ms: number) {
      slept.push(ms);
    }
    function run() {
      return untilDeploymentReady(request, onWait, sleep);
    }
    return { posted, waits, slept, run };
  }

  test("a trigger refused while the deployment is not ready is retried with backoff and announced once", async () => {
    const { posted, waits, slept, run } = harness([notReady()]);
    await run();
    expect(posted).toHaveLength(2);
    expect(waits).toEqual(["waiting"]);
    expect(slept).toEqual([1_000]);
  });

  test("another conflict is thrown without a retry", async () => {
    const conflict = new ApiError(409, "already_queued", "acme/widgets#1 is already queued for triage.");
    const { posted, waits, run } = harness([conflict]);
    await expect(run()).rejects.toBe(conflict);
    expect(posted).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test("once the budget is spent the last refusal is thrown", async () => {
    const last = notReady();
    const { posted, waits, slept, run } = harness([notReady(), notReady(), notReady(), notReady(), last]);
    await expect(run()).rejects.toBe(last);
    expect(posted).toHaveLength(5);
    expect(waits).toEqual(["waiting"]);
    expect(slept).toEqual([1_000, 2_000, 4_000, 8_000]);
  });
});

describe("pending maintainer write approvals", () => {
  test("overlays a parked github_merge_pr approval onto the pull request", () => {
    const merge: HubApproval = {
      ...approval("merge"),
      runId: "run-write",
      anchorRunId: "run-write",
      toolDefinition: { name: "github_merge_pr" },
      toolArguments: { repo: "acme/widgets", number: 8 },
    };
    const [item] = queue([merge]);
    expect(item).toMatchObject({ pendingApprovalId: "merge", needsHuman: true });
  });
});

test("a preview posts the draft pack, so unsaved edits are previewed", async () => {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const transport: Transport = {
    async fetch(method, path, body) {
      sent.push({ method, path, body });
      return {} as never;
    },
    subscribe: () => () => {},
  };
  const pack = { ...recommendedPack("acme/widgets"), actions: { ...defaultActions(), unsure: [{ do: "close" as const }] } };
  await previewPull(transport, "tenant", { repo: "acme/widgets", number: 12, pack });
  expect(sent).toEqual([{ method: "POST", path: "/api/integrations/github-preview/tenant", body: { repo: "acme/widgets", number: 12, pack } }]);
});
