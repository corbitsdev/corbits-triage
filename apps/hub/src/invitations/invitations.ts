// An invite is a stock invited principal. The invitee accepts on the portal's
// /invite/{tenantId} page, signed in with a verified address: with email, the
// better-auth magic link that lands there signs them in and verifies it; without
// email, they must have signed in with Google first.
import { type } from "arktype";
import { and, count, eq, exists, gt, inArray, like, notExists, sql } from "drizzle-orm";
import { schema } from "@intx/db";
import { TRIAGE_ROLE, type InviteRoles } from "@corbits/triage-contracts";
import { isEmailAllowed, MAGIC_LINK_TTL_SECONDS, type HubAuth } from "../auth.js";
import type { SessionUser } from "@intx/hub-api";
import { failure, type PortalCredentialDeps } from "../github/portal-credential.js";
import type { IsHubOwner } from "../hub-owner.js";
import type { Member } from "../integrations/app.js";
import { asCaller } from "../stock-caller.js";
import type { SendInviteEmail } from "./invite-email.js";

export const INVITATIONS_PATH = "/api/integrations/invitations";
export const ACCEPT_PATH = "/api/integrations/invite-accept";

const LINKS_PER_ADDRESS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const RESEND_INTERVAL_MS = 60 * 1000;
const GOOGLE_FIRST = "Without email set up on this hub, invitees must sign in with Google first.";

export const InviteBody = type({ email: "string.email", roleId: "string > 0" });
export const AcceptBody = type({ tenantId: "string > 0" });
export const Accepted = type({ tenantId: "string" });
const StockPrincipal = type({ id: "string" });

function isTriageRole(role: { name: string; isSystem: boolean }): boolean {
  return role.isSystem && role.name === TRIAGE_ROLE;
}

export type InvitationDeps = PortalCredentialDeps & {
  auth: HubAuth;
  stockFetch: (req: Request) => Promise<Response>;
  allowedEmails: readonly string[] | undefined;
  linkOrigin: string;
  sendEmail: SendInviteEmail | undefined;
  isHubOwner: IsHubOwner;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

/** SMTP error messages can echo the recipient, so only the error's kind is logged. */
function sendFailure(error: unknown): Record<string, unknown> {
  const { code, responseCode } = typeof error === "object" && error !== null ? error as { code?: unknown; responseCode?: unknown } : {};
  return { error: error instanceof Error ? error.name : typeof error, code, responseCode };
}

export function createInvitations(deps: InvitationDeps) {
  const { db } = deps;

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

  /** Why this address may not be sent an invite now. Magic links outlive a withdrawn invite, so they are what is counted. */
  async function sendingRefusal(email: string): Promise<Response | null> {
    if (deps.allowedEmails !== undefined && !isEmailAllowed(email, deps.allowedEmails)) {
      return failure(403, "forbidden", `${email} is not allowed to sign in to this service.`);
    }
    const [recent] = await db
      .select({ sent: count() })
      .from(schema.verification)
      .where(and(
        like(schema.verification.identifier, "magic-link:%"),
        eq(sql`${schema.verification.value}::jsonb->>'email'`, email),
        gt(schema.verification.createdAt, new Date(deps.now().getTime() - HOUR_MS)),
      ));
    if ((recent?.sent ?? 0) >= LINKS_PER_ADDRESS_PER_HOUR) {
      return failure(429, "too_many_invites", `${email} was sent ${LINKS_PER_ADDRESS_PER_HOUR} invite links in the last hour. Try again later.`);
    }
    return null;
  }

  async function sendLink(req: Request, tenantId: string, principalId: string, email: string, status: number): Promise<Response> {
    const landing = `${deps.linkOrigin}/invite/${encodeURIComponent(tenantId)}`;
    const { sendEmail } = deps;
    if (sendEmail === undefined) return Response.json({ principalId, email, emailed: false, link: landing }, { status });
    const tenant = await db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId) });
    if (!tenant) throw new Error(`tenant ${tenantId} not found`);
    const workspace = tenant.name;
    const deliverEmail: SendInviteEmail = sendEmail;
    const expiresAt = new Date(deps.now().getTime() + MAGIC_LINK_TTL_SECONDS * 1000);
    let failed: Record<string, unknown> | undefined;
    async function deliver(url: string) {
      try {
        await deliverEmail({ to: email, workspace, link: url, expiresAt });
      } catch (error: unknown) {
        failed = sendFailure(error);
      }
    }
    // The marker lets the page join straight away; a copied link waits for a Join click.
    await deps.auth.api.signInMagicLink({ body: { email, callbackURL: `${landing}?from=email`, metadata: { deliver } }, headers: req.headers });
    if (failed !== undefined) {
      deps.log({ level: "warn", msg: "invite_email_failed", tenantId, principalId, ...failed });
      return failure(502, "email_failed", "The invite is saved but the email could not be sent. Resend it.");
    }
    return Response.json({ principalId, email, emailed: true }, { status });
  }

  async function create(body: typeof InviteBody.infer, { tenantId, principalId }: Member, req: Request): Promise<Response> {
    const email = body.email.trim().toLowerCase();
    const role = await db.query.role.findFirst({ where: and(eq(schema.role.id, body.roleId), eq(schema.role.tenantId, tenantId)) });
    if (!role) return failure(404, "not_found", "Role not found in this workspace.");
    if (isTriageRole(role)) return failure(403, "forbidden", "Triage's own role cannot be given to a person.");
    if (!(await assignableRoles(principalId, tenantId, [role.id])).has(role.id)) {
      return failure(403, "forbidden", "You may not invite people into a role with permissions you do not hold.");
    }
    const refused = await sendingRefusal(email);
    if (refused) return refused;
    const { internalAdapter } = await deps.auth.$context;
    const existing = await internalAdapter.findUserByEmail(email, { includeAccounts: true });
    // Whoever set up an unverified account may not own the address, so the emailed link must not sign it in.
    // Without email nothing is sent, and it can join only once the hub's owner marks it verified.
    if (existing && !existing.user.emailVerified && existing.accounts.length > 0 && deps.sendEmail !== undefined) {
      return failure(409, "unverified_email", `${email} has an account whose address is not verified, so it cannot be invited. Its owner can verify it with Reset password on the sign-in page.`);
    }
    let created: string | undefined;
    if (!existing) {
      if (deps.sendEmail === undefined) return failure(404, "not_found", `No account uses ${email}. ${GOOGLE_FIRST}`);
      // Stock invites only existing users; this one can do nothing until the magic link proves the address.
      try {
        created = (await internalAdapter.createUser({ email, name: "", emailVerified: false }, { method: "magic-link" })).id;
      } catch (error: unknown) {
        // A simultaneous invite created it first.
        if (!(await internalAdapter.findUserByEmail(email))) throw error;
      }
    }
    const invited = await deps.stockFetch(asCaller(req, "POST", `/api/tenants/${encodeURIComponent(tenantId)}/members/invite`, { email, roleId: role.id }));
    if (!invited.ok) {
      if (created !== undefined) await internalAdapter.deleteUser(created);
      return invited;
    }
    return sendLink(req, tenantId, StockPrincipal.assert(await invited.json()).id, email, 201);
  }

  async function invitedRow(tenantId: string, invitedId: string) {
    const [row] = await db
      .select({ userId: schema.user.id, email: schema.user.email, updatedAt: schema.principal.updatedAt })
      .from(schema.principal)
      .innerJoin(schema.user, eq(schema.user.id, schema.principal.refId))
      .where(and(eq(schema.principal.id, invitedId), eq(schema.principal.tenantId, tenantId), eq(schema.principal.status, "invited")));
    return row;
  }

  async function resend(req: Request, { tenantId, principalId }: Member, invitedId: string): Promise<Response> {
    const row = await invitedRow(tenantId, invitedId);
    if (!row) return failure(404, "not_found", "No open invite for this person.");
    const assigned = await db.select({ roleId: schema.principalRole.roleId }).from(schema.principalRole).where(eq(schema.principalRole.principalId, invitedId));
    const roleIds = assigned.map((entry) => entry.roleId);
    const assignable = await assignableRoles(principalId, tenantId, roleIds);
    if (roleIds.some((roleId) => !assignable.has(roleId))) {
      return failure(403, "forbidden", "You may not resend an invite into a role with permissions you do not hold.");
    }
    if (deps.now().getTime() - row.updatedAt.getTime() < RESEND_INTERVAL_MS) {
      return failure(429, "too_many_invites", "This invite was just sent. Wait a minute before sending it again.");
    }
    const refused = await sendingRefusal(row.email);
    if (refused) return refused;
    await db.update(schema.principal).set({ updatedAt: deps.now() }).where(eq(schema.principal.id, invitedId));
    return sendLink(req, tenantId, invitedId, row.email, 200);
  }

  /** The stock principal delete, plus the user an invite created when nothing else holds it, so the address stays free to sign up. */
  async function withdraw(req: Request, { tenantId }: Member, invitedId: string): Promise<Response> {
    const row = await invitedRow(tenantId, invitedId);
    if (!row) return failure(404, "not_found", "No open invite for this person.");
    const deleted = await deps.stockFetch(asCaller(req, "DELETE", `/api/tenants/${encodeURIComponent(tenantId)}/principals/${encodeURIComponent(invitedId)}`));
    if (!deleted.ok) return deleted;
    await db.delete(schema.user).where(and(
      eq(schema.user.id, row.userId),
      eq(schema.user.emailVerified, false),
      notExists(db.select({ id: schema.principal.id }).from(schema.principal).where(eq(schema.principal.refId, row.userId))),
      notExists(db.select({ id: schema.account.id }).from(schema.account).where(eq(schema.account.userId, row.userId))),
    ));
    return new Response(null, { status: 204 });
  }

  /** People in the workspace, members or invited, who signed up with email and password and have not verified it. */
  function unverifiedPeople(tenantId: string, principalId?: string) {
    return db
      .select({ principalId: schema.principal.id, userId: schema.user.id })
      .from(schema.principal)
      .innerJoin(schema.user, eq(schema.user.id, schema.principal.refId))
      .where(and(
        eq(schema.principal.tenantId, tenantId),
        principalId === undefined ? undefined : eq(schema.principal.id, principalId),
        eq(schema.principal.kind, "user"),
        eq(schema.user.emailVerified, false),
        exists(db.select({ id: schema.account.id }).from(schema.account).where(and(eq(schema.account.userId, schema.user.id), eq(schema.account.providerId, "credential")))),
      ));
  }

  async function callerIsHubOwner(principalId: string): Promise<boolean> {
    const [caller] = await db.select({ userId: schema.principal.refId }).from(schema.principal).where(eq(schema.principal.id, principalId));
    return caller !== undefined && await deps.isHubOwner(caller.userId);
  }

  /**
   * The hub's owner vouches for an address, as a hub without email cannot prove it. Verified holds hub-wide, and any
   * verified account can bring others into a workspace of its own, so no workspace admin may vouch.
   */
  async function markVerified({ tenantId, principalId }: Member, targetId: string): Promise<Response> {
    if (deps.sendEmail !== undefined) return failure(409, "sends_email", "This hub sends email, so they verify their address with the link it sent them.");
    if (!await callerIsHubOwner(principalId)) return failure(403, "forbidden", "Only whoever runs this Triage may verify an address.");
    const [row] = await unverifiedPeople(tenantId, targetId);
    if (!row) return failure(404, "not_found", "No one in this workspace with an unverified address has this id.");
    await db.update(schema.user).set({ emailVerified: true, updatedAt: deps.now() }).where(eq(schema.user.id, row.userId));
    deps.log({ level: "info", msg: "email_marked_verified", tenantId, byPrincipalId: principalId, principalId: targetId, userId: row.userId });
    return new Response(null, { status: 204 });
  }

  async function roles({ tenantId, principalId }: Member): Promise<Response> {
    const rows = await db.select({ id: schema.role.id, name: schema.role.name, isSystem: schema.role.isSystem }).from(schema.role).where(eq(schema.role.tenantId, tenantId));
    const people = rows.filter((row) => !isTriageRole(row)).map((row) => row.id);
    const { allowedEmails } = deps;
    const signInLimit = allowedEmails === undefined
      ? null
      : { domains: allowedEmails.filter((entry) => entry.startsWith("@")), addresses: allowedEmails.some((entry) => !entry.startsWith("@")) };
    const unverified = deps.sendEmail === undefined ? await unverifiedPeople(tenantId) : [];
    const body: InviteRoles = {
      assignableRoleIds: [...await assignableRoles(principalId, tenantId, people)],
      sendsEmail: deps.sendEmail !== undefined,
      signInLimit,
      unverifiedPrincipalIds: unverified.map((row) => row.principalId),
      canMarkVerified: deps.sendEmail === undefined && await callerIsHubOwner(principalId),
    };
    return Response.json(body);
  }

  async function accept(body: typeof AcceptBody.infer, user: SessionUser): Promise<Response> {
    // Matching the invited address proves nothing until its owner has verified it.
    if (!user.emailVerified) {
      return failure(403, "unverified_email", "Your address is not verified. Open the link in the invite email, or use Reset password on the sign-in page.");
    }
    const [row] = await db
      .select({ id: schema.principal.id, status: schema.principal.status })
      .from(schema.principal)
      .where(and(eq(schema.principal.tenantId, body.tenantId), eq(schema.principal.kind, "user"), eq(schema.principal.refId, user.id)));
    if (!row) return failure(404, "not_found", "You have no invite to this workspace. Ask for a new one.");
    if (row.status === "invited") {
      await db.update(schema.principal).set({ status: "active", updatedAt: deps.now() }).where(eq(schema.principal.id, row.id));
    } else if (row.status !== "active") {
      return failure(403, "suspended", "Your access to this workspace is suspended.");
    }
    return Response.json({ tenantId: body.tenantId });
  }

  return { create, resend, withdraw, markVerified, roles, accept };
}
