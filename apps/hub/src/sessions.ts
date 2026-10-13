// The caller's own sign-ins, without their tokens: with bearer auth a raw session token is a credential.
import { type } from "arktype";
import { and, asc, eq, gt } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { failure } from "./github/portal-credential.js";
import type { Caller } from "./integrations/app.js";

export const SESSIONS_PATH = "/api/integrations/sessions";

export const SessionList = type({
  sessions: type({ id: "string", userAgent: "string | null", createdAt: "string", expiresAt: "string", isCurrent: "boolean" }).array(),
});

export function createSessions(db: DB["db"]) {
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

  async function revoke(current: Caller, sessionId: string): Promise<Response> {
    const [deleted] = await db
      .delete(schema.session)
      .where(and(eq(schema.session.id, sessionId), eq(schema.session.userId, current.user.id)))
      .returning({ id: schema.session.id });
    return deleted ? new Response(null, { status: 204 }) : failure(404, "not_found", "Session not found.");
  }

  return { list, revoke };
}
