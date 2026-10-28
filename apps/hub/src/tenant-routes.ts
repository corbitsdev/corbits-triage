import type { Hono } from "hono";
import type { AppEnv } from "@intx/hub-api";
import { createCronRoutes, type CronDb } from "@corbits/cron";
import { createManagerRoutes, type ManagerRoutesDeps } from "./manager-routes.js";

/** The hub's own routes under `/api/tenants/:tenantId/`, mounted on the stock app after its tenant resolution. */
export function mountTenantRoutes(app: Hono<AppEnv>, { db, requireGrant, log, wake, supersede, taken }: ManagerRoutesDeps & { db: CronDb }): void {
  app.route("/api/tenants/:tenantId/cron", createCronRoutes({ db, requireGrant }));
  app.route("/api/tenants/:tenantId", createManagerRoutes({ db, requireGrant, log, wake, supersede, taken }));
}
