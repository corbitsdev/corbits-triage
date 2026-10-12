// No stock principal exists until the invitee accepts, so the invite itself
// lives here. The token is kept encrypted so an admin can copy the link later.
import { createHash } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { DB } from "@intx/db";

export const invitation = pgTable("corbits_triage_invitation", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  email: text("email").notNull(),
  roleId: text("role_id").notNull(),
  invitedBy: text("invited_by"),
  tokenHash: text("token_hash").notNull(),
  token: text("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedBy: text("accepted_by"),
  emailedAt: timestamp("emailed_at", { withTimezone: true }),
});

export type Invitation = typeof invitation.$inferSelect;

export async function migrateInvitations(db: DB["db"]): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS corbits_triage_invitation (
      id text PRIMARY KEY,
      tenant_id text NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
      email text NOT NULL,
      role_id text NOT NULL REFERENCES role(id) ON DELETE CASCADE,
      invited_by text REFERENCES principal(id) ON DELETE SET NULL,
      token_hash text NOT NULL UNIQUE,
      token text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      accepted_at timestamptz,
      accepted_by text REFERENCES "user"(id) ON DELETE SET NULL,
      emailed_at timestamptz
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS corbits_triage_invitation_email_idx ON corbits_triage_invitation (email, tenant_id)`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS corbits_triage_invitation_open_idx ON corbits_triage_invitation (tenant_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL
  `);
}

/** Neither accepted, revoked nor expired. */
export function isOpen(now: Date) {
  return and(isNull(invitation.acceptedAt), isNull(invitation.revokedAt), gt(invitation.expiresAt, now))!;
}

export function tokenAad(id: string): string {
  return JSON.stringify(["corbits-triage-invitation", id]);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function invitationKey(tenantId: string, id: string) {
  return and(eq(invitation.tenantId, tenantId), eq(invitation.id, id))!;
}
