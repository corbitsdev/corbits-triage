// Shared gates for portal requests that act on GitHub as the workspace's App.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import type { GithubFetch } from "@corbits/github-tool/github";
import { validManifestMutationRequest } from "./manifest.js";

type SessionResult = { user: { id: string } };

export type PortalCredentialDeps = {
  db: DB["db"];
  cipher: CredentialCipher;
  getSession: (headers: Headers) => Promise<SessionResult | null>;
  authorize: (principalId: string, tenantId: string, resource: string, action: string) => Promise<boolean>;
  trustedPortalOrigins: readonly string[];
};

export function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** The signed-in member's principal id, or the error response to return. */
export async function portalMember(d: PortalCredentialDeps, req: Request, tenantId: string): Promise<string | Response> {
  const trusted = new Set([new URL(req.url).origin, ...d.trustedPortalOrigins]);
  if (!validManifestMutationRequest(req, trusted)) return failure(403, "forbidden", "This request did not come from the portal.");
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

/** The decrypted App credential when the member holds `action` on it, or the error response to return. */
export async function githubAppCredential(
  d: PortalCredentialDeps,
  principalId: string,
  tenantId: string,
  action: "use" | "manage",
): Promise<string | Response> {
  const credential = await d.db.query.credential.findFirst({
    where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.name, "github"), eq(schema.credential.status, "active")),
  });
  if (!credential) return failure(409, "github_not_connected", "Connect GitHub first.");
  if (!(await d.authorize(principalId, tenantId, `credential:${credential.id}`, action))) {
    return failure(403, "forbidden", "You do not have access to the GitHub App credential.");
  }
  return d.cipher.decrypt(credential.secret, credentialAad(credential.id, "secret"));
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
