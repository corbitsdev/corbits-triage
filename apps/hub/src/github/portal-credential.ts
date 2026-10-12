// Shared gates for portal requests that reach GitHub as the workspace's App.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import type { GithubFetch } from "@corbits/github-tool/github";
import { APPROVE_ACTION, reviewResource } from "./admin-github-grant.js";
import { validManifestMutationRequest } from "./manifest.js";

type SessionResult = { user: { id: string } };

export type PortalCredentialDeps = {
  db: DB["db"];
  cipher: CredentialCipher;
  getSession: (headers: Headers) => Promise<SessionResult | null>;
  authorize: (principalId: string, tenantId: string, resource: string, action: string) => Promise<boolean>;
  trustedPortalOrigins: readonly string[];
};

export function failure(status: number, code: string, message: string, details?: Record<string, string>): Response {
  return Response.json({ error: { ...details, code, message } }, { status });
}

/** The signed-in member's principal id, or the error response to return. */
// Browsers omit Origin on same-origin GETs, and reads change nothing, so they only need to not be cross-site.
export function fromPortal(req: Request, trustedOrigins: readonly string[]): boolean {
  if (req.method === "GET") return req.headers.get("sec-fetch-site")?.toLowerCase() !== "cross-site";
  return validManifestMutationRequest(req, new Set([new URL(req.url).origin, ...trustedOrigins]));
}

export async function portalMember(d: PortalCredentialDeps, req: Request, tenantId: string): Promise<string | Response> {
  if (!fromPortal(req, d.trustedPortalOrigins)) return failure(403, "forbidden", "This request did not come from the portal.");
  const session = await d.getSession(req.headers);
  if (!session) return failure(401, "unauthorized", "Sign in again.");
  const member = await d.db.query.principal.findFirst({
    where: and(
      eq(schema.principal.tenantId, tenantId),
      eq(schema.principal.kind, "user"),
      eq(schema.principal.refId, session.user.id),
      eq(schema.principal.status, "active"),
    ),
  });
  if (!member) return failure(401, "unauthorized", "You are not a member of this workspace.");
  return member.id;
}

/** The member's principal id when they hold `workflow-run:*` read, which reading triage runs needs, or the error response to return. */
export async function runReadPrincipal(d: PortalCredentialDeps, req: Request, tenantId: string): Promise<string | Response> {
  const principalId = await portalMember(d, req, tenantId);
  if (principalId instanceof Response) return principalId;
  if (await d.authorize(principalId, tenantId, "workflow-run:*", "read")) return principalId;
  return failure(403, "forbidden", "You do not have access to this workspace's triage runs.");
}

async function holds(d: PortalCredentialDeps, principalId: string, tenantId: string, resource: string, action: string): Promise<boolean> {
  if (await d.authorize(principalId, tenantId, resource, action)) return true;
  return action === "read" && d.authorize(principalId, tenantId, resource, "use");
}

/** The decrypted App credential when the member holds `action` on it, or the error response to return. Holding `use` also allows `read`. */
export async function githubAppCredential(
  d: PortalCredentialDeps,
  principalId: string,
  tenantId: string,
  action: "read" | "use" | "manage",
): Promise<string | Response> {
  const credential = await d.db.query.credential.findFirst({
    where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.name, "github"), eq(schema.credential.status, "active")),
  });
  if (!credential) return failure(409, "github_not_connected", "Connect GitHub first.");
  if (!(await holds(d, principalId, tenantId, `credential:${credential.id}`, action))) {
    return failure(403, "forbidden", "You do not have access to the GitHub App credential.");
  }
  return d.cipher.decrypt(credential.secret, credentialAad(credential.id, "secret"));
}

/** The response to return when the member may not approve pull requests in `repo`. */
export async function approvalRefused(d: PortalCredentialDeps, principalId: string, tenantId: string, repo: string): Promise<Response | undefined> {
  if (await d.authorize(principalId, tenantId, reviewResource(repo), APPROVE_ACTION)) return undefined;
  return failure(403, "forbidden", "You do not have the grant to approve pull requests in this repository.");
}

/** GitHub fetch that the App credential adapter turns into App-JWT or installation-token calls. */
export function appGithubFetch(
  appFetch: (input: string, init?: RequestInit) => Promise<Response>,
  apiOrigin: string,
  appJson: string,
): GithubFetch {
  return function appCredentialFetch(path, init) {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${appJson}`);
    headers.set("accept", "application/vnd.github+json");
    return appFetch(`${apiOrigin}${path}`, { ...init, headers });
  };
}
