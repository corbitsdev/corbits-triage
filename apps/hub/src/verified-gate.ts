// Every hub API route, stock and custom, refuses a signed-in user whose address is not verified, except
// what getting verified needs. The hub's first account is exempt so a hub without email can be set up;
// under an allowlist nobody is, since it admits only proven addresses.
import type { GetSession } from "@intx/hub-api";
import { AUTH_METHODS_PATH } from "./auth.js";
import { failure } from "./github/portal-credential.js";
import type { IsHubOwner } from "./hub-owner.js";

const OPEN_PREFIXES = ["/api/auth/"];
const OPEN_PATHS = [AUTH_METHODS_PATH];

export type VerifiedGateDeps = {
  isHubOwner: IsHubOwner;
  getSession: GetSession;
  allowedEmails: readonly string[] | undefined;
};

function isOpen(pathname: string): boolean {
  return !pathname.startsWith("/api/") || OPEN_PATHS.includes(pathname) || OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function createVerifiedGate({ isHubOwner, getSession, allowedEmails }: VerifiedGateDeps) {
  /** The refusal for a request from an unverified account, or null to let it through. */
  return async function refuseUnverified(req: Request): Promise<Response | null> {
    if (isOpen(new URL(req.url).pathname)) return null;
    const current = await getSession(req.headers);
    if (current === null || current.user.emailVerified || (allowedEmails === undefined && await isHubOwner(current.user.id))) return null;
    return failure(403, "email_unverified", "Verify your email address to use Corbits Triage.");
  };
}
