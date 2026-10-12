// No stock principal exists until the invitee accepts, so the invite itself
// lives here. The token is kept encrypted so an admin can copy the link later.
import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { text, timestamp } from "drizzle-orm/pg-core";
import { triageSchema } from "../triage-db.js";

export const invitation = triageSchema.table("invitation", {
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
