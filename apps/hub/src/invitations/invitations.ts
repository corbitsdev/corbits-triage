import { randomBytes } from "node:crypto";
import { type } from "arktype";
import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { createPrincipalStore, schema, type PrincipalKeyStore } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { isEmailAllowed } from "../auth.js";
import { readJson } from "../read-json.js";
import { failure, fromPortal, portalMember, type PortalCredentialDeps } from "../github/portal-credential.js";
import { hashToken, invitation, invitationKey, isOpen, tokenAad, type Invitation } from "./invitation-store.js";
import type { SendInviteEmail } from "./invite-email.js";

export const INVITATIONS_PATH = "/api/integrations/invitations";
export const MY_INVITATIONS_PATH = "/api/integrations/my-invitations";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITES_PER_TENANT_PER_HOUR = 50;
const HOUR_MS = 60 * 60 * 1000;

export const InviteBody = type({ email: "string.email", roleId: "string > 0" });
export const AcceptBody = type({ token: "string > 0" });

const InvitationView = type({
  id: "string",
  email: "string",
  role: { id: "string", name: "string" },
  createdAt: "string",
  expiresAt: "string",
  "link?": "string",
});
export const InvitationCreated = InvitationView.and({ emailed: "boolean" });
export const InvitationList = type({ invitations: InvitationView.array(), assignableRoleIds: "string[]" });
export const MyInvitations = type({
  invitations: type({ id: "string", tenantId: "string", tenantName: "string", tenantSlug: "string", expiresAt: "string" }).array(),
});
export const Accepted = type({ tenantId: "string" });

type InvitationView = typeof InvitationView.infer;

export type InvitationDeps = Omit<PortalCredentialDeps, "getSession"> & {
  getSession: (headers: Headers) => Promise<{ user: { id: string; email: string; emailVerified: boolean } } | null>;
  principalKeyStore: PrincipalKeyStore;
  allowedEmails: readonly string[] | undefined;
  linkOrigin: string;
  sendEmail: SendInviteEmail | undefined;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

/** SMTP error messages can echo the recipient, so only the error's kind is logged. */
function sendFailure(error: unknown): Record<string, unknown> {
  const { code, responseCode } = typeof error === "object" && error !== null ? error as { code?: unknown; responseCode?: unknown } : {};
  return { error: error instanceof Error ? error.name : typeof error, code, responseCode };
}

function normalEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createInvitations(deps: InvitationDeps) {
  const { db } = deps;
  const principalStore = createPrincipalStore(db, deps.principalKeyStore);

  function linkFor(token: string): string {
    return `${deps.linkOrigin}/invite/${token}`;
  }

  /** The link is left out for a caller who could not have sent this invite. */
  async function view(row: Invitation, role: { id: string; name: string }, withLink: boolean): Promise<InvitationView> {
    return {
      id: row.id,
      email: row.email,
      role,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      ...(withLink && { link: linkFor(await deps.cipher.decrypt(row.token, tokenAad(row.id))) }),
    };
  }

  /** The member's principal id when they may invite, or the error response to return. */
  async function inviter(req: Request, tenantId: string): Promise<string | Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    if (!(await deps.authorize(principalId, tenantId, "principal:*", "create"))) {
      return failure(403, "forbidden", "You may not invite people to this workspace.");
    }
    return principalId;
  }

  /** Roles whose every granted permission the principal holds itself, so inviting into them escalates nothing. */
  async function assignableRoles(principalId: string, tenantId: string, roleIds: string[]): Promise<Set<string>> {
    if (roleIds.length === 0) return new Set();
    const grants = await db
      .select({ roleId: schema.grant.roleId, resource: schema.grant.resource, action: schema.grant.action })
      .from(schema.grant)
      .where(and(eq(schema.grant.tenantId, tenantId), inArray(schema.grant.roleId, roleIds), inArray(schema.grant.effect, ["allow", "ask"])));
    const assignable = new Set(roleIds);
    for (const grant of grants) {
      if (grant.roleId === null || !assignable.has(grant.roleId)) continue;
      if (!(await deps.authorize(principalId, tenantId, grant.resource, grant.action))) assignable.delete(grant.roleId);
    }
    return assignable;
  }

  async function isActiveMember(tenantId: string, email: string): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.principal.id })
      .from(schema.principal)
      .innerJoin(schema.user, eq(schema.user.id, schema.principal.refId))
      .where(and(
        eq(schema.principal.tenantId, tenantId),
        eq(schema.principal.kind, "user"),
        eq(schema.principal.status, "active"),
        eq(sql`lower(${schema.user.email})`, email),
      ));
    return row !== undefined;
  }

  async function create(req: Request, tenantId: string): Promise<Response> {
    const principalId = await inviter(req, tenantId);
    if (principalId instanceof Response) return principalId;
    const body = InviteBody(await readJson(req));
    if (body instanceof type.errors) return failure(400, "invalid_request", body.summary);
    const email = normalEmail(body.email);
    const role = await db.query.role.findFirst({ where: and(eq(schema.role.id, body.roleId), eq(schema.role.tenantId, tenantId)) });
    if (!role) return failure(404, "not_found", "Role not found in this workspace.");
    if (!(await assignableRoles(principalId, tenantId, [role.id])).has(role.id)) {
      return failure(403, "forbidden", "You may not invite people into a role with permissions you do not hold.");
    }
    if (deps.allowedEmails !== undefined && !isEmailAllowed(email, deps.allowedEmails)) {
      return failure(403, "forbidden", `${email} is not allowed to sign in to this service.`);
    }
    if (await isActiveMember(tenantId, email)) return failure(409, "conflict", `${email} is already a member.`);
    const [recent] = await db
      .select({ sent: count() })
      .from(invitation)
      .where(and(eq(invitation.tenantId, tenantId), gt(invitation.createdAt, new Date(deps.now().getTime() - HOUR_MS))));
    if ((recent?.sent ?? 0) >= INVITES_PER_TENANT_PER_HOUR) {
      return failure(429, "too_many_invites", `This workspace sent ${INVITES_PER_TENANT_PER_HOUR} invites in the last hour. Try again later.`);
    }

    const id = `inv_${randomBytes(16).toString("hex")}`;
    const token = randomBytes(32).toString("base64url");
    const now = deps.now();
    const row = await db.transaction(async function replaceInvite(tx) {
      // Serializes invites to one address, so exactly one stays open.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`corbits-triage-invitation:${tenantId}:${email}`}))`);
      await tx
        .update(invitation)
        .set({ revokedAt: now })
        .where(and(eq(invitation.tenantId, tenantId), eq(invitation.email, email), isNull(invitation.acceptedAt), isNull(invitation.revokedAt)));
      const [inserted] = await tx.insert(invitation).values({
        id,
        tenantId,
        email,
        roleId: role.id,
        invitedBy: principalId,
        tokenHash: hashToken(token),
        token: await deps.cipher.encrypt(token, tokenAad(id)),
        createdAt: now,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      }).returning();
      if (!inserted) throw new Error(`invitation ${id} was not stored`);
      return inserted;
    });
    const created = await view(row, { id: role.id, name: role.name }, true);
    if (deps.sendEmail === undefined) return Response.json({ ...created, emailed: false }, { status: 201 });
    const tenant = await db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId) });
    if (!tenant) throw new Error(`tenant ${tenantId} not found`);
    try {
      await deps.sendEmail({ to: email, workspace: tenant.name, link: linkFor(token), expiresAt: row.expiresAt });
    } catch (error: unknown) {
      deps.log({ level: "warn", msg: "invite_email_failed", tenantId, invitationId: id, ...sendFailure(error) });
      return failure(502, "email_failed", "The invite is saved but the email could not be sent. Copy its link and send it yourself.");
    }
    await db.update(invitation).set({ emailedAt: deps.now() }).where(eq(invitation.id, id));
    return Response.json({ ...created, emailed: true }, { status: 201 });
  }

  async function list(req: Request, tenantId: string): Promise<Response> {
    const principalId = await inviter(req, tenantId);
    if (principalId instanceof Response) return principalId;
    const rows = await db
      .select({ invitation, role: { id: schema.role.id, name: schema.role.name } })
      .from(invitation)
      .innerJoin(schema.role, eq(schema.role.id, invitation.roleId))
      .where(and(eq(invitation.tenantId, tenantId), isOpen(deps.now())))
      .orderBy(desc(invitation.createdAt));
    const roles = await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.tenantId, tenantId));
    const assignable = await assignableRoles(principalId, tenantId, roles.map((role) => role.id));
    const invitations = await Promise.all(rows.map((row) => view(row.invitation, row.role, assignable.has(row.role.id))));
    return Response.json({ invitations, assignableRoleIds: [...assignable] });
  }

  async function revoke(req: Request, tenantId: string, invitationId: string): Promise<Response> {
    const principalId = await inviter(req, tenantId);
    if (principalId instanceof Response) return principalId;
    const now = deps.now();
    const [revoked] = await db.update(invitation).set({ revokedAt: now }).where(and(invitationKey(tenantId, invitationId), isOpen(now))).returning({ id: invitation.id });
    if (revoked) return new Response(null, { status: 204 });
    const [closed] = await db.select({ id: invitation.id }).from(invitation).where(invitationKey(tenantId, invitationId));
    return closed ? failure(409, "conflict", "This invite was already used, withdrawn or expired.") : failure(404, "not_found", "Invite not found.");
  }

  async function signedInUser(req: Request) {
    if (!fromPortal(req, deps.trustedPortalOrigins)) return failure(403, "forbidden", "This request did not come from the portal.");
    const session = await deps.getSession(req.headers);
    return session ? session.user : failure(401, "unauthorized", "Sign in again.");
  }

  async function mine(req: Request): Promise<Response> {
    const user = await signedInUser(req);
    if (user instanceof Response) return user;
    // An unverified address may belong to someone else, who must not learn which workspaces invited it.
    if (!user.emailVerified) return Response.json({ invitations: [] });
    const rows = await db
      .select({ id: invitation.id, tenantId: invitation.tenantId, tenantName: schema.tenant.name, tenantSlug: schema.tenant.slug, expiresAt: invitation.expiresAt })
      .from(invitation)
      .innerJoin(schema.tenant, eq(schema.tenant.id, invitation.tenantId))
      .where(and(eq(invitation.email, normalEmail(user.email)), isOpen(deps.now())))
      .orderBy(desc(invitation.createdAt));
    return Response.json({ invitations: rows.map((row) => ({ ...row, expiresAt: row.expiresAt.toISOString() })) });
  }

  async function accept(req: Request): Promise<Response> {
    const user = await signedInUser(req);
    if (user instanceof Response) return user;
    const body = AcceptBody(await readJson(req));
    if (body instanceof type.errors) return failure(400, "invalid_request", body.summary);
    const now = deps.now();
    return db.transaction(async function acceptInvite(tx) {
      const [row] = await tx.select().from(invitation).where(eq(invitation.tokenHash, hashToken(body.token))).for("update");
      if (!row) return failure(404, "not_found", "This invite link is not valid.");
      if (row.acceptedAt !== null) {
        return row.acceptedBy === user.id
          ? Response.json({ tenantId: row.tenantId })
          : failure(409, "conflict", "This invite was already used.");
      }
      if (row.revokedAt !== null) return failure(410, "revoked", "This invite was withdrawn. Ask for a new one.");
      if (row.expiresAt <= now) return failure(410, "expired", "This invite expired. Ask for a new one.");
      if (normalEmail(user.email) !== row.email) {
        return failure(403, "wrong_email", "This invite is for a different email. Sign in with the invited address.");
      }
      const [existing] = await tx
        .select()
        .from(schema.principal)
        .where(and(eq(schema.principal.tenantId, row.tenantId), eq(schema.principal.kind, "user"), eq(schema.principal.refId, user.id)))
        .for("update");
      if (existing?.status === "suspended") return failure(403, "suspended", "Your access to this workspace is suspended.");
      if (existing?.status === "active") return failure(409, "conflict", "You are already a member of this workspace.");
      const principalId = existing
        ? existing.id
        : (await principalStore.create({ id: generateId("principal"), tenantId: row.tenantId, kind: "user", refId: user.id, status: "active", createdAt: now, updatedAt: now }, tx)).id;
      if (existing) {
        await tx.update(schema.principal).set({ status: "active", updatedAt: now }).where(eq(schema.principal.id, existing.id));
        await tx.delete(schema.principalRole).where(eq(schema.principalRole.principalId, existing.id));
      }
      await tx.insert(schema.principalRole).values({ principalId, roleId: row.roleId, createdAt: now });
      await tx.update(invitation).set({ acceptedAt: now, acceptedBy: user.id }).where(eq(invitation.id, row.id));
      return Response.json({ tenantId: row.tenantId });
    });
  }

  return { create, list, revoke, mine, accept };
}
