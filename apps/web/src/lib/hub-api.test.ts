import { describe, expect, test } from "bun:test";
import { ApiError, type Transport } from "@intx/hub-client";
import {
  createGrant,
  deleteGrant,
  configureGithubApp,
  ensureHookCredential,
  githubAppSecret,
  GITHUB_HOOK_CREDENTIAL_NAME,
  portalConnected,
  projectQueue,
  queueRows,
  reposFromConfig,
  removeRepository,
  saveInference,
  saveRepoPolicy,
  startBacklogTriage,
  startPullRequestTriage,
  patchAppConfig,
  type HubApproval,
  type HubRun,
  type PortalSnapshot,
  type RunLog,
} from "./hub-api.ts";

const inline = (value: unknown) => ({ ref: `inline:${JSON.stringify(value)}` });

const duplicateLog: RunLog = {
  runId: "run-triage",
  anchorRunId: "run-triage",
  events: [
    { seq: 0, type: "RunStarted", body: { trigger: { payload: JSON.stringify({ kind: "pr", repo: "acme/widgets", prNumber: 8 }) } } },
    {
      seq: 1,
      type: "StepCompleted",
      body: {
        stepId: "render",
        output: inline({
          repo: "acme/widgets",
          number: 8,
          state: "needs-decision",
          labels: ["needs-decision"],
          feedback: "Duplicate of #7",
          nextAction: "Confirm duplicate or withdraw",
          humanGated: true,
          duplicate: true,
          close: false,
        }),
      },
    },
  ],
};

const approval = (id: string, close: boolean): HubApproval => ({
  id,
  runId: close ? "run-close" : "run-triage",
  anchorRunId: close ? "run-close" : "run-triage",
  status: "pending",
  scope: null,
  toolDefinition: { name: "github_mirror" },
  toolArguments: { repo: "acme/widgets", number: 8, labels: ["needs-decision"], comment: "Duplicate of #7", close },
  correlationId: id,
});

const snapshot = (approvals: HubApproval[]): PortalSnapshot => ({
  workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
  tenantName: "Acme",
  repos: [],
  credentials: [],
  grants: [],
  principals: [],
  roles: [],
  approvals,
  runs: [],
  logs: [duplicateLog],
  awaiting: [],
  denied: { repos: false, credentials: false, grants: false, approvals: false, runs: false, logs: false },
});

describe("duplicate close projection", () => {
  test("starts open and exposes a human close action even when the ordinary mirror approval has close:false", () => {
    const [item] = projectQueue(snapshot([approval("mirror", false)]));
    expect(item).toMatchObject({ canClose: true, pendingApprovalId: "mirror", pendingClose: false });
  });

  test("prefers the human-created close approval carrying close:true", () => {
    const [item] = projectQueue(snapshot([approval("mirror", false), approval("close", true)]));
    expect(item).toMatchObject({ canClose: true, pendingApprovalId: "close", pendingClose: true });
  });

  test("a rejected close approval leaves the duplicate open", () => {
    const rejected = { ...approval("close", true), status: "denied" };
    const [item] = projectQueue(snapshot([approval("mirror", false), rejected]));
    expect(item).toMatchObject({ canClose: true, pendingApprovalId: "mirror", pendingClose: false });
  });

  test("keeps the canonical pull request href when an approval is pending", () => {
    const [item] = projectQueue(snapshot([approval("mirror", false)]));
    expect(item?.href).toBe("/triage/pr/acme/widgets/8");
    expect(item?.runId).toBe("run-triage");
  });
});

describe("needs-human queue sources", () => {
  test("includes pending approvals and awaited signals while human-gated PRs remain projected", () => {
    const current = snapshot([approval("mirror", false)]);
    current.awaiting = [{ runId: "run-waiting", anchorRunId: "run-waiting", signalName: "maintainer", seq: 4 }];

    expect(projectQueue(current).filter((item) => item.needsHuman).map((item) => item.key)).toEqual(["acme/widgets#8"]);
    expect(queueRows(current, true).map((row) => row.id)).toEqual(["mirror", "run-waiting:maintainer"]);
  });
});

describe("All-view queue sources", () => {
  test("does not surface listener deployments as pull requests when the project queue is empty", () => {
    const current = snapshot([]);
    current.logs = [];
    current.runs = [
      { id: "run_b0d08b", definitionId: "def-install", definitionName: "github-installations", status: "error", createdAt: "2026-03-10T00:00:00.000Z" },
      { id: "run_cbc581", definitionId: "def-close", definitionName: "duplicate-close", status: "error", createdAt: "2026-03-10T00:00:00.000Z" },
      { id: "run_300931", definitionId: "def-members", definitionName: "org-members", status: "error", createdAt: "2026-03-10T00:00:00.000Z" },
      { id: "run_c37896", definitionId: "def-backlog", definitionName: "pr-triage-historical", status: "error", createdAt: "2026-03-10T00:00:00.000Z" },
    ] satisfies HubRun[];

    expect(projectQueue(current)).toEqual([]);
    const titles = queueRows(current, false).map((row) => row.title);
    expect(titles).not.toContain("github-installations");
    expect(titles).not.toContain("duplicate-close");
    expect(titles).not.toContain("org-members");
    expect(titles).not.toContain("pr-triage-historical");
    expect(queueRows(current, false)).toEqual([]);
  });

  test("needs-human still lists pending approvals and awaited signals beside listener runs", () => {
    const current = snapshot([approval("mirror", false)]);
    current.runs = [
      { id: "run_b0d08b", definitionId: "def-install", definitionName: "github-installations", status: "error", createdAt: "2026-03-10T00:00:00.000Z" },
    ];
    current.awaiting = [{ runId: "run-waiting", anchorRunId: "run-waiting", signalName: "maintainer", seq: 4 }];

    expect(queueRows(current, true).map((row) => row.id)).toEqual(["mirror", "run-waiting:maintainer"]);
    expect(queueRows(current, true).map((row) => row.title)).not.toContain("github-installations");
  });
});

describe("projectQueue reply unwrap", () => {
  test("unwraps output.reply as a single verdict or items list", () => {
    const single: RunLog = {
      runId: "run-reply",
      anchorRunId: "run-reply",
      events: [
        { seq: 0, type: "RunStarted", body: { trigger: { payload: JSON.stringify({ kind: "pr", repo: "acme/widgets", prNumber: 8 }) } } },
        {
          seq: 1,
          type: "StepCompleted",
          body: {
            stepId: "renderJudged",
            output: inline({
              reply: JSON.stringify({
                repo: "acme/widgets",
                number: 8,
                state: "needs-decision",
                confidence: 0.9,
                humanGated: true,
              }),
            }),
          },
        },
      ],
    };
    const listed: RunLog = {
      runId: "run-items",
      anchorRunId: "run-items",
      events: [
        { seq: 0, type: "RunStarted", body: { trigger: { payload: JSON.stringify({ kind: "backlog", repo: "acme/gadgets" }) } } },
        {
          seq: 1,
          type: "StepCompleted",
          body: {
            stepId: "renderAll",
            output: inline({
              reply: JSON.stringify({
                items: [{ repo: "acme/gadgets", number: 3, state: "ready-monitoring", confidence: 0.4 }],
              }),
            }),
          },
        },
      ],
    };
    const current = snapshot([]);
    current.logs = [single, listed];
    expect(projectQueue(current)).toEqual([
      expect.objectContaining({ key: "acme/widgets#8", confidence: 0.9, needsHuman: true }),
      expect.objectContaining({ key: "acme/gadgets#3", confidence: 0.4, state: "ready" }),
    ]);
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
    const configured = snapshot([]);
    configured.credentials = [{ id: "credential", name: "github", status: "active", providerId: "provider" }];
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
  test("createGrant posts origin creator for a person and never system", async () => {
    const posted: unknown[] = [];
    const transport: Transport = {
      fetch: async (method, path, body) => {
        posted.push({ method, path, body });
        return { id: "grn_1" } as never;
      },
      subscribe: () => () => {},
    };
    await createGrant(transport, "tenant", {
      principalId: "prn_ada",
      resource: "workflow-run:*",
      action: "read",
      effect: "allow",
    });
    expect(posted).toEqual([
      {
        method: "POST",
        path: "/api/tenants/tenant/grants",
        body: {
          principalId: "prn_ada",
          resource: "workflow-run:*",
          action: "read",
          effect: "allow",
          origin: "creator",
        },
      },
    ]);
  });

  test("createGrant posts origin role for a role", async () => {
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
      effect: "ask",
    });
    expect(posted).toEqual([
      {
        method: "POST",
        path: "/api/tenants/tenant/grants",
        body: {
          roleId: "rol_owner",
          resource: "grant:*",
          action: "manage",
          effect: "ask",
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
      cleanupMode: "human-approved",
      classificationAuthorized: true,
      checks: {
        draft: true,
        ci: true,
        duplicate: true,
        conflicts: true,
        reviewers: false,
        drift: true,
      },
    })]);
  });

  test("saveRepoPolicy PATCHes only that repo and spreads other fields", async () => {
    let config: Record<string, unknown> = {
      other: 1,
      corbitsTriage: {
        confidenceFloor: 0.7,
        repos: [
          { name: "acme/one", connected: true, installationId: 9 },
          { name: "acme/two", connected: true, cleanupMode: "automated" },
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

    await saveRepoPolicy(transport, "tenant", "acme/one", {
      cleanupMode: "automated",
      classificationAuthorized: false,
      checks: {
        draft: true,
        ci: false,
        duplicate: true,
        conflicts: true,
        reviewers: true,
        drift: true,
      },
    });

    expect(config.other).toBe(1);
    const ns = config.corbitsTriage as { confidenceFloor: number; repos: Array<Record<string, unknown>> };
    expect(ns.confidenceFloor).toBe(0.7);
    expect(ns.repos[0]).toMatchObject({
      name: "acme/one",
      connected: true,
      installationId: 9,
      cleanupMode: "automated",
      classificationAuthorized: false,
      checks: { ci: false, draft: true },
    });
    expect(ns.repos[1]).toEqual({ name: "acme/two", connected: true, cleanupMode: "automated" });
  });
});

describe("paused classification triggers", () => {
  const pausedConfig = {
    corbitsTriage: {
      repos: [{ name: "acme/widgets", connected: true, classificationAuthorized: false }],
    },
  };

  function transport(posted: unknown[]): Transport {
    return {
      fetch: async (method, path, body) => {
        if (method === "GET" && path === "/api/tenants/tenant") {
          return { id: "tenant", name: "Tenant", slug: "tenant", config: pausedConfig } as never;
        }
        if (method === "GET" && path === "/api/tenants/tenant/workflows/deployments") {
          return [{
            id: "deployment-backlog",
            tenantId: "tenant",
            definitionAssetId: "asset-pr-triage-historical",
            status: "deployed",
            createdAt: "2026-03-10T00:00:00.000Z",
          }] as never;
        }
        if (method === "GET" && path === "/api/tenants/tenant/assets?kind=workflow") {
          return [
            { id: "asset-pr-triage-historical", kind: "workflow", name: "pr-triage-historical" },
            { id: "asset-pr-triage", kind: "workflow", name: "pr-triage" },
          ] as never;
        }
        if (method === "POST") {
          posted.push({ method, path, body });
          return { runId: "run-1", address: "pr-triage-historical", messageId: "msg-1" } as never;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
      subscribe: () => () => {},
    };
  }

  test("startBacklogTriage throws and does not mail", async () => {
    const posted: unknown[] = [];
    await expect(startBacklogTriage(transport(posted), "tenant", "acme/widgets")).rejects.toThrow(
      "Classification is paused for this repository.",
    );
    expect(posted).toEqual([]);
  });

  test("startPullRequestTriage throws and does not mail", async () => {
    const posted: unknown[] = [];
    await expect(startPullRequestTriage(transport(posted), "tenant", JSON.stringify({ kind: "pr", repo: "acme/widgets", prNumber: 8 }))).rejects.toThrow(
      "Classification is paused for this repository.",
    );
    expect(posted).toEqual([]);
  });
});

describe("pending maintainer write approvals", () => {
  test("overlays a parked github_merge_pr approval onto the pull request", () => {
    const merge: HubApproval = {
      id: "merge",
      runId: "run-write",
      anchorRunId: "run-write",
      status: "pending",
      scope: null,
      toolDefinition: { name: "github_merge_pr" },
      toolArguments: { repo: "acme/widgets", number: 8 },
      correlationId: "merge",
    };
    const [item] = projectQueue(snapshot([merge]));
    expect(item).toMatchObject({ pendingApprovalId: "merge", pendingClose: false, needsHuman: true });
  });
});
