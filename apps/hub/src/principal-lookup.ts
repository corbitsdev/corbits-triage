import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";

const { principal } = schema;

// Mirrors stock's findUserPrincipal (@intx/hub-api principal-lookup), which its package index does not export.
export async function findUserPrincipal(db: DB["db"], { tenantId, userId }: { tenantId: string; userId: string }) {
  return await db.query.principal.findFirst({
    where: and(eq(principal.tenantId, tenantId), eq(principal.kind, "user"), eq(principal.refId, userId)),
  });
}
