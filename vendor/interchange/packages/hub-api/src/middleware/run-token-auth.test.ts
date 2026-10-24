import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createInMemoryGrantStore } from "@intx/authz";
import type { DB } from "@intx/db";
import {
  createEventCollectorRegistry,
  createSidecarRouter,
  type SessionService,
} from "@intx/hub-sessions";

import { createHubContextMiddleware, mountHubRoutes } from "../app";
import type { AppEnv, TenantEnv } from "../context";
import {
  isRunTokenRoute,
  matchesRunTokenRoute,
  type RunTokenRoute,
} from "./run-token-auth";

const RUN = "/api/tenants/tnt_a/workflows/runs";

describe("matchesRunTokenRoute", () => {
  test("a parameter matches one non-empty segment", () => {
    const pattern = "/api/tenants/:tenantId/workflows/runs/:runId";
    expect(matchesRunTokenRoute(pattern, `${RUN}/run_1`)).toBe(true);
    expect(matchesRunTokenRoute(pattern, `${RUN}/`)).toBe(false);
    expect(matchesRunTokenRoute(pattern, `${RUN}/run_1/events`)).toBe(false);
  });

  test("an encoded slash stays inside its segment", () => {
    const pattern = "/api/tenants/:tenantId/workflows/runs/:runId/events";
    expect(matchesRunTokenRoute(pattern, `${RUN}/a%2Fb/events`)).toBe(true);
  });

  test("a trailing slash is a different path", () => {
    expect(
      matchesRunTokenRoute("/api/tenants/:tenantId/workflows/runs", `${RUN}/`),
    ).toBe(false);
  });
});

describe("isRunTokenRoute", () => {
  test("allows a listed method and path", () => {
    expect(isRunTokenRoute("GET", RUN)).toBe(true);
    expect(isRunTokenRoute("DELETE", `${RUN}/run_1`)).toBe(true);
  });

  test("refuses a listed path with another method", () => {
    expect(isRunTokenRoute("POST", `${RUN}/run_1/mail`)).toBe(false);
    expect(isRunTokenRoute("HEAD", RUN)).toBe(false);
  });

  test("refuses a path that is not listed", () => {
    expect(isRunTokenRoute("GET", "/api/tenants/tnt_a/grants")).toBe(false);
    expect(isRunTokenRoute("POST", "/api/tenants/tnt_a/federation")).toBe(
      false,
    );
  });

  test("a run id that reads `runs` matches the run routes", () => {
    // `/workflows/runs/runs` matches the run-detail pattern; both patterns it
    // could match are read routes the router sends to the run router.
    expect(isRunTokenRoute("GET", `${RUN}/runs`)).toBe(true);
  });
});

describe("host run-token routes", () => {
  const principal = {
    id: "prn_run",
    tenantId: "tnt_a",
    kind: "workflow",
    refId: "run_1",
    status: "active",
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only the run-token lookup and resolveTenantPrincipal touch the DB
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            { id: "rtk_1", principalId: principal.id, consumer: "hub" },
          ],
        }),
      }),
    }),
    query: {
      tenant: { findFirst: async () => ({ id: "tnt_a" }) },
      principal: { findFirst: async () => principal },
    },
  } as unknown as DB["db"];
  const sessionService: SessionService = {
    stageWorkflowStep() {
      throw new Error("mock: sessionService.stageWorkflowStep");
    },
    endSession() {
      throw new Error("mock: sessionService.endSession");
    },
  };

  function hubApp(extraRunTokenRoutes: readonly RunTokenRoute[]) {
    const app = new Hono<AppEnv>();
    app.use(createHubContextMiddleware({ getSession: async () => null }));
    mountHubRoutes(app, {
      db,
      grantStore: createInMemoryGrantStore([]),
      sidecarRouter: createSidecarRouter({
        withExecutableWorkflowRun: async (_target, send) => send(),
        authenticateSidecar: async ({ sidecarId }) => ({ sidecarId }),
        resolveSidecarBindings: async () => [],
        validateSidecarIdentity: async () => true,
      }),
      sessionService,
      eventCollectors: createEventCollectorRegistry({ db }),
      assetService: null,
      repoStore: null,
      maxTarballBytes: 10_000_000,
      extraRunTokenRoutes,
    });
    return app;
  }

  test("a run token reaches a host route the hub lists, and stock routes still pass", async () => {
    const app = hubApp([
      { method: "GET", path: "/api/tenants/:tenantId/host/state" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- run-token auth sets the tenant variables on this route
    const tenantRoutes = app as unknown as Hono<TenantEnv>;
    tenantRoutes.get("/api/tenants/:tenantId/host/state", (c) =>
      c.text(c.var.principal.id),
    );
    const headers = { authorization: "Bearer itx_run_secret" };

    const host = await app.request("/api/tenants/tnt_a/host/state", {
      headers,
    });
    expect(host.status).toBe(200);
    expect(await host.text()).toBe(principal.id);

    // Past run-token auth, the stock route answers with its own grant check.
    const stock = await app.request(
      "/api/tenants/tnt_a/workflows/definitions",
      {
        headers,
      },
    );
    expect(await stock.json()).toEqual({
      error: {
        code: "forbidden",
        message: "You do not have permission to perform this action",
      },
    });
  });

  test("the hub refuses an extra that could reach a stock route", () => {
    expect(() =>
      hubApp([{ method: "GET", path: "/api/tenants/:tenantId/grants" }]),
    ).toThrow("overlaps");
    expect(() =>
      hubApp([{ method: "GET", path: "/api/tenants/:tenantId/roles/:x" }]),
    ).toThrow("overlaps");
    expect(() =>
      hubApp([{ method: "GET", path: "/api/tenants/:tenantId/:a/:b" }]),
    ).toThrow("not under");
  });
});
