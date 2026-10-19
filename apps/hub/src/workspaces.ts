// A signed-in user sees only their own memberships, so whether the hub already has a triage workspace is answered here.
import { eq, like, or } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { WORKSPACE_SLUG } from "@corbits/triage-contracts";

export const WORKSPACES_EXISTS_PATH = "/api/integrations/workspaces/exists";

export function createWorkspaceExists(db: DB["db"]) {
  return async function workspaceExists(): Promise<Response> {
    const [found] = await db
      .select({ id: schema.tenant.id })
      .from(schema.tenant)
      .where(or(eq(schema.tenant.slug, WORKSPACE_SLUG), like(schema.tenant.slug, `${WORKSPACE_SLUG}-%`)))
      .limit(1);
    return Response.json({ exists: found !== undefined });
  };
}
