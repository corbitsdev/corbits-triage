import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";

import { sha256 } from "@intx/crypto";
import type { DB, RunTokenStore } from "@intx/db";
import { RUN_TOKEN_PREFIX } from "@intx/hub-common";
import { getLogger } from "@intx/log";

import type { TenantEnv } from "../context";
import { errorResponse } from "../error-response";
import { resolveTenantPrincipal } from "../principal-lookup";

const log = getLogger(["hub", "run-token"]);

const BEARER_SCHEME = "bearer ";

/** A route a workflow run token may reach: a method and a Hono path pattern. */
export type RunTokenRoute = {
  method: "GET" | "POST" | "DELETE";
  path: string;
};

/**
 * The only tenant routes a workflow run token may reach. Every other route
 * refuses a run token, whatever grants the run holds, so a run can never
 * resolve approvals, change grants, roles, credentials, OAuth clients, tokens
 * or federation trusts, or manage the tenant. The routes listed still apply
 * their own grant checks. Patterns use the router's form, and a test holds
 * each one to a registered route so a renamed route cannot leave a stale
 * entry.
 */
export const RUN_TOKEN_ROUTES: readonly RunTokenRoute[] = [
  { method: "GET", path: "/api/tenants/:tenantId/workflows/runs" },
  {
    method: "GET",
    path: "/api/tenants/:tenantId/workflows/runs/blobs/:blobId",
  },
  { method: "GET", path: "/api/tenants/:tenantId/workflows/runs/:runId" },
  { method: "DELETE", path: "/api/tenants/:tenantId/workflows/runs/:runId" },
  {
    method: "GET",
    path: "/api/tenants/:tenantId/workflows/runs/:runId/health",
  },
  {
    method: "GET",
    path: "/api/tenants/:tenantId/workflows/runs/:runId/lifecycle",
  },
  {
    method: "GET",
    path: "/api/tenants/:tenantId/workflows/runs/:runId/events",
  },
  {
    method: "GET",
    path: "/api/tenants/:tenantId/workflows/runs/:runId/turns",
  },
  { method: "GET", path: "/api/tenants/:tenantId/workflows/runs/:runId/mail" },
  { method: "GET", path: "/api/tenants/:tenantId/workflows/deployments" },
  { method: "POST", path: "/api/tenants/:tenantId/workflows/deployments" },
  { method: "POST", path: "/api/tenants/:tenantId/workflows/:runId/signals" },
  { method: "GET", path: "/api/tenants/:tenantId/workflows/:runId/runs" },
  {
    method: "GET",
    path: "/api/tenants/:tenantId/workflows/:runId/runs/:eventRunId/events",
  },
  { method: "GET", path: "/api/tenants/:tenantId/workflows/definitions" },
  {
    method: "GET",
    path: "/api/tenants/:tenantId/workflows/definitions/:definitionId/versions",
  },
  { method: "GET", path: "/api/tenants/:tenantId/assets" },
  { method: "GET", path: "/api/tenants/:tenantId/assets/:assetId" },
  { method: "GET", path: "/api/tenants/:tenantId/assets/:assetId/tarballs" },
];

/**
 * Whether a request path matches a route pattern. A `:name` segment matches
 * exactly one non-empty segment, and a trailing slash is a segment. The caller
 * passes the path the router routes on: decoded, except that an encoded slash
 * stays inside its segment.
 */
export function matchesRunTokenRoute(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const have = path.split("/");
  if (want.length !== have.length) return false;
  return want.every((segment, i) => {
    const actual = have[i];
    if (actual === undefined) return false;
    if (segment.startsWith(":")) return actual.length > 0;
    return segment === actual;
  });
}

function matchesAnyRunTokenRoute(
  routes: readonly RunTokenRoute[],
  method: string,
  path: string,
): boolean {
  return routes.some(
    (route) =>
      route.method === method && matchesRunTokenRoute(route.path, path),
  );
}

export function isRunTokenRoute(
  method: string,
  path: string,
  extraRoutes: readonly RunTokenRoute[] = [],
): boolean {
  return (
    matchesAnyRunTokenRoute(RUN_TOKEN_ROUTES, method, path) ||
    matchesAnyRunTokenRoute(extraRoutes, method, path)
  );
}

const HOST_RUN_TOKEN_ROUTE = /^\/api\/tenants\/:tenantId\/[^/:*{}]+(\/|$)/;

/** A route registered on the app, as Hono lists it in `app.routes`. */
type RegisteredRoute = { method: string; path: string };

function isMiddleware(route: RegisteredRoute): boolean {
  return route.method === "ALL" && route.path.endsWith("*");
}

/**
 * Whether two route patterns can match the same path. A `:param` segment on
 * either side matches any one segment, and a trailing `*` matches the rest.
 */
function routePatternsOverlap(a: string, b: string): boolean {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (
      (l === "*" && i === left.length - 1) ||
      (r === "*" && i === right.length - 1)
    ) {
      return true;
    }
    if (l === undefined || r === undefined) return false;
    if (l !== r && !l.startsWith(":") && !r.startsWith(":")) return false;
  }
  return true;
}

/**
 * Refuse host run-token routes that could reach a route the app already
 * registers, so an extra can only admit host routes and never re-open a stock
 * route the allow-list refuses. Each extra must sit under a literal segment
 * below `/api/tenants/:tenantId`, and must not overlap a registered route of
 * the same method; middleware is not a route.
 */
export function assertHostRunTokenRoutes(
  extraRoutes: readonly RunTokenRoute[],
  registered: readonly RegisteredRoute[],
): void {
  for (const extra of extraRoutes) {
    if (!HOST_RUN_TOKEN_ROUTE.test(extra.path)) {
      throw new Error(
        `Host run-token route ${extra.method} ${extra.path} is not under /api/tenants/:tenantId/<literal>`,
      );
    }
    const clash = registered.find(
      (route) =>
        !isMiddleware(route) &&
        (route.method === extra.method || route.method === "ALL") &&
        routePatternsOverlap(route.path, extra.path),
    );
    if (clash !== undefined) {
      throw new Error(
        `Host run-token route ${extra.method} ${extra.path} overlaps ${clash.method} ${clash.path}`,
      );
    }
  }
}

export type CreateRunTokenAuthDeps = {
  db: DB["db"];
  runTokenStore: RunTokenStore;
  /**
   * Host routes a run token may also reach, beyond `RUN_TOKEN_ROUTES`. They
   * match the same way. Each listed route must apply its own grant checks.
   */
  extraRoutes?: readonly RunTokenRoute[];
};

/**
 * Authenticate a workflow run token on the tenant routes. A request without
 * an `Authorization: Bearer itx_run_...` header passes through untouched, so
 * the session flow and the git bearer routes are unchanged. A run token
 * resolves to its run principal in the URL's tenant, and the request carries
 * the token's consumer so a grant scoped to a consumer applies only to it.
 *
 * On success the middleware sets `tenant`, `principal` and `consumer`, which
 * makes `resolveTenant` skip the session lookup.
 */
export function createRunTokenAuth({
  db,
  runTokenStore,
  extraRoutes = [],
}: CreateRunTokenAuthDeps): MiddlewareHandler<TenantEnv> {
  return createMiddleware<TenantEnv>(async (c, next) => {
    const secret = readRunToken(c.req.header("authorization"));
    if (secret === null) return await next();

    const token = await runTokenStore.findByHash(await sha256(secret));
    if (token === undefined) {
      log.info("run-token auth: unknown token");
      return errorResponse(c, "unauthorized", "Authentication required");
    }

    const tenantId = c.req.param("tenantId");
    if (!tenantId) {
      return errorResponse(c, "bad_request", "Missing tenantId");
    }

    const resolved = await resolveTenantPrincipal(db, {
      tenantId,
      select: { principalId: token.principalId },
    });

    if (
      resolved.kind === "tenant_not_found" ||
      resolved.kind === "principal_not_found"
    ) {
      log.info("run-token auth: token not valid for tenant {tokenId}", {
        tokenId: token.id,
      });
      return errorResponse(
        c,
        "forbidden",
        "Token is not valid for this tenant",
      );
    }

    if (resolved.kind === "principal_inactive") {
      log.info("run-token auth: run principal not active {tokenId}", {
        tokenId: token.id,
        principalId: resolved.principal.id,
        status: resolved.principal.status,
      });
      return errorResponse(c, "unauthorized", "Authentication required");
    }

    const { tenant: tenantRow, principal: principalRow } = resolved;

    if (principalRow.kind !== "workflow") {
      log.error(
        "run-token auth: token {tokenId} names principal {principalId} of kind {kind}",
        {
          tokenId: token.id,
          principalId: principalRow.id,
          kind: principalRow.kind,
        },
      );
      return errorResponse(c, "unauthorized", "Authentication required");
    }

    if (!isRunTokenRoute(c.req.method, c.req.path, extraRoutes)) {
      log.info("run-token auth: route refused {tokenId} {method} {path}", {
        tokenId: token.id,
        method: c.req.method,
        path: c.req.path,
      });
      return errorResponse(
        c,
        "forbidden",
        "A workflow run token cannot use this route",
      );
    }

    log.info(
      "run-token auth: success {tokenId} principal={principalId} consumer={consumer} tenant={tenantId}",
      {
        tokenId: token.id,
        principalId: principalRow.id,
        consumer: token.consumer,
        tenantId: tenantRow.id,
      },
    );

    c.set("tenant", tenantRow);
    c.set("principal", principalRow);
    c.set("consumer", token.consumer);

    await next();
  });
}

function readRunToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) {
    return null;
  }
  const secret = trimmed.slice(BEARER_SCHEME.length).trim();
  return secret.startsWith(RUN_TOKEN_PREFIX) ? secret : null;
}
