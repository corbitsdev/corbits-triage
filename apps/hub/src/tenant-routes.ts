import type { Hono } from "hono";
import type { AppEnv } from "@intx/hub-api";
import { createArtifactRoutes, InlineContentStore, type ArtifactDb } from "@corbits/artifacts";
import { createCronRoutes, type CronDb } from "@corbits/cron";
import { createArtifactGrants } from "./artifact-grants.js";
import { createManagerRoutes, type ManagerRoutesDeps } from "./manager-routes.js";

/** The hub's own routes under `/api/tenants/:tenantId/`, mounted on the stock app after its tenant resolution. */
export function mountTenantRoutes(app: Hono<AppEnv>, { db, requireGrant, intake, log, now }: ManagerRoutesDeps & { db: ArtifactDb & CronDb; now: () => Date }): void {
  app.route("/api/tenants/:tenantId", createArtifactRoutes({
    db,
    contentStore: InlineContentStore,
    requireGrant,
    onArtifactCreated: createArtifactGrants(now),
  }));
  app.route("/api/tenants/:tenantId/cron", createCronRoutes({ db, requireGrant }));
  app.route("/api/tenants/:tenantId", createManagerRoutes({ db, requireGrant, intake, log }));
}
