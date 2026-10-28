// The caller's own sign-ins, without their tokens: with bearer auth a raw session token is a credential.
import { and, asc, eq, gt } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import type { HubAuth } from "./auth.js";
import { failure } from "./github/portal-credential.js";
import type { Caller } from "./integrations/app.js";

export const SESSIONS_PATH = "/api/integrations/sessions";

export function createSessions(db: DB["db"], auth: HubAuth) {
  async function list(current: Caller): Promise<Response> {
    const rows = await db
      .select({ id: schema.session.id, userAgent: schema.session.userAgent, createdAt: schema.session.createdAt, expiresAt: schema.session.expiresAt })
      .from(schema.session)
      .where(and(eq(schema.session.userId, current.user.id), gt(schema.session.expiresAt, new Date())))
      .orderBy(asc(schema.session.createdAt));
    const sessions = rows.map((row) => ({
      id: row.id,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      isCurrent: row.id === current.session.id,
    }));
    return Response.json({ sessions });
  }

  // Stock deletes by token, so the token comes from the caller's own sessions and another user's id is not found.
  async function revoke(current: Caller, sessionId: string): Promise<Response> {
    const { internalAdapter } = await auth.$context;
    const own = await internalAdapter.listSessions(current.user.id);
    const target = own.find((session) => session.id === sessionId);
    if (!target) return failure(404, "not_found", "Session not found.");
    await internalAdapter.deleteSession(target.token);
    return new Response(null, { status: 204 });
  }

  return { list, revoke };
}
