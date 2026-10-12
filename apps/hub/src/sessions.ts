// The caller's own sign-ins, without their tokens: with bearer auth a raw session token is a credential.
import { type } from "arktype";
import { and, asc, eq, gt } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { failure, fromPortal } from "./github/portal-credential.js";

export const SESSIONS_PATH = "/api/integrations/sessions";

export const SessionList = type({
  sessions: type({ id: "string", userAgent: "string | null", createdAt: "string", expiresAt: "string", isCurrent: "boolean" }).array(),
});

export type SessionsDeps = {
  db: DB["db"];
  getSession: (headers: Headers) => Promise<{ user: { id: string }; session: { id: string } } | null>;
  trustedPortalOrigins: readonly string[];
};

export function createSessions(deps: SessionsDeps) {
  async function caller(req: Request) {
    if (!fromPortal(req, deps.trustedPortalOrigins)) return failure(403, "forbidden", "This request did not come from the portal.");
    return (await deps.getSession(req.headers)) ?? failure(401, "unauthorized", "Sign in again.");
  }

  async function list(req: Request): Promise<Response> {
    const current = await caller(req);
    if (current instanceof Response) return current;
    const rows = await deps.db
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

  async function revoke(req: Request, sessionId: string): Promise<Response> {
    const current = await caller(req);
    if (current instanceof Response) return current;
    const [deleted] = await deps.db
      .delete(schema.session)
      .where(and(eq(schema.session.id, sessionId), eq(schema.session.userId, current.user.id)))
      .returning({ id: schema.session.id });
    return deleted ? new Response(null, { status: 204 }) : failure(404, "not_found", "Session not found.");
  }

  return { list, revoke };
}
