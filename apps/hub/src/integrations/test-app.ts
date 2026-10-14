import type { GrantStore } from "@intx/authz";
import type { DB } from "@intx/db";
import { createRequireGrant, type GetSession } from "@intx/hub-api";
import { createIntegrationsApp, type IntegrationHandlers } from "./app.js";

export function guardedApp(
  db: DB["db"],
  getSession: GetSession,
  grantStore: GrantStore,
  handlers: Partial<IntegrationHandlers>,
) {
  const requireGrant = createRequireGrant({ grantStore, conditionRegistry: {} });
  return createIntegrationsApp({ db, getSession, requireGrant, trustedPortalOrigins: [], log() {} }, handlers as IntegrationHandlers);
}
