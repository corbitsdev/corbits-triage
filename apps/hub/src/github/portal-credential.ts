// Shared gates for portal requests that reach GitHub as the workspace's App.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import type { GithubFetch } from "@corbits/github-reads";
import { DO_GRANT_ACTION, doResource, TRIAGE_ROLE, type ActionKind } from "@corbits/triage-contracts";
import { TOKEN_CREDENTIAL } from "../bitbucket-datacenter/records.js";
import { sourceOf, type RepoRecord } from "./tenant-config.js";

export type PortalCredentialDeps = {
  db: DB["db"];
  cipher: CredentialCipher;
  authorize: (principalId: string, tenantId: string, resource: string, action: string) => Promise<boolean>;
};

export function failure(status: number, code: string, message: string, details?: Record<string, string>): Response {
  return Response.json({ error: { ...details, code, message } }, { status });
}

export async function memberPrincipal(db: DB["db"], tenantId: string, userId: string): Promise<string | undefined> {
  const member = await db.query.principal.findFirst({
    where: and(
      eq(schema.principal.tenantId, tenantId),
      eq(schema.principal.kind, "user"),
      eq(schema.principal.refId, userId),
      eq(schema.principal.status, "active"),
    ),
  });
  return member?.id;
}

export async function holds(d: PortalCredentialDeps, principalId: string, tenantId: string, resource: string, action: string): Promise<boolean> {
  if (await d.authorize(principalId, tenantId, resource, action)) return true;
  return action === "read" && d.authorize(principalId, tenantId, resource, "use");
}

type CredentialAction = "read" | "use" | "manage";

export function activeCredential(db: DB["db"], tenantId: string, name: string) {
  return db.query.credential.findFirst({
    where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.name, name), eq(schema.credential.status, "active")),
  });
}

/** The App credential's row when the member holds `action` on it, or the error response to return. Holding `use` also allows `read`. */
export async function githubAppGrant(d: PortalCredentialDeps, principalId: string, tenantId: string, action: CredentialAction) {
  const credential = await activeCredential(d.db, tenantId, "github");
  if (!credential) return failure(409, "github_not_connected", "Connect GitHub first.");
  if (!(await holds(d, principalId, tenantId, `credential:${credential.id}`, action))) {
    return failure(403, "forbidden", "You do not have access to the GitHub App credential.");
  }
  return credential;
}

/** Whether the member holds `action` on the credential of the record's host; a missing credential is a 409 naming the host. */
export async function sourceCredentialGrant(d: PortalCredentialDeps, principalId: string, tenantId: string, record: Pick<RepoRecord, "source">, action: CredentialAction): Promise<Response | undefined> {
  if (sourceOf(record) === "github") {
    const grant = await githubAppGrant(d, principalId, tenantId, action);
    return grant instanceof Response ? grant : undefined;
  }
  const credential = await activeCredential(d.db, tenantId, TOKEN_CREDENTIAL);
  if (!credential) return failure(409, "bitbucket_datacenter_not_connected", "Connect Bitbucket Data Center first.");
  if (!(await holds(d, principalId, tenantId, `credential:${credential.id}`, action))) return failure(403, "forbidden", "You do not have access to the Bitbucket Data Center credential.");
  return undefined;
}

export async function githubAppCredential(d: PortalCredentialDeps, principalId: string, tenantId: string, action: CredentialAction): Promise<string | Response> {
  const credential = await githubAppGrant(d, principalId, tenantId, action);
  if (credential instanceof Response) return credential;
  return d.cipher.decrypt(credential.secret, credentialAad(credential.id, "secret"));
}

async function holdsTriageRole(db: DB["db"], principalId: string, tenantId: string): Promise<boolean> {
  const { principalRole, role } = schema;
  const [held] = await db.select({ roleId: principalRole.roleId }).from(principalRole)
    .innerJoin(role, eq(role.id, principalRole.roleId))
    .where(and(eq(principalRole.principalId, principalId), eq(role.tenantId, tenantId), eq(role.name, TRIAGE_ROLE), eq(role.isSystem, true)));
  return held !== undefined;
}

/**
 * The response to return when the member does not hold the grant for Dos of `kind` in `repo`. Stock lets an admin
 * assign any role, so a member given triage's own role is refused every Do until it is removed: what triage may do
 * unattended never becomes what a person may do.
 */
export async function doRefused(
  d: PortalCredentialDeps & { log: (entry: Record<string, unknown>) => void },
  principalId: string,
  tenantId: string,
  repo: string,
  kind: ActionKind,
): Promise<Response | undefined> {
  if (await holdsTriageRole(d.db, principalId, tenantId)) {
    d.log({ level: "warn", msg: "do_refused_triage_role", tenantId, principalId, repo, kind });
    return failure(403, "forbidden", "Triage's own role cannot act for a person. Remove it from this member first.");
  }
  if (await d.authorize(principalId, tenantId, doResource(kind, repo), DO_GRANT_ACTION)) return undefined;
  return failure(403, "forbidden", "You do not have the grant for this kind of Do in this repository.");
}

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
