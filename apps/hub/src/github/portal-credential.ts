// Shared gates for portal requests that reach GitHub as the workspace's App.
import { and, eq } from "drizzle-orm";
import { resolveCredentialByName, schema, type DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import type { GithubFetch } from "@corbits/github-reads";
import { DO_GRANT_ACTION, doResource, TRIAGE_ROLE, type ActionKind, type RepoSource } from "@corbits/triage-contracts";
import { TOKEN_CREDENTIAL } from "../bitbucket-datacenter/names.js";
import { GITHUB_CREDENTIAL, githubAppKey, githubAppLogin, type AppKeyDeps } from "./app-key.js";
import { githubUsage } from "./github-usage.js";
import { sourceOf, type RepoRecord } from "./tenant-config.js";

export type PortalCredentialDeps = AppKeyDeps & {
  authorize: (principalId: string, tenantId: string, resource: string, action: string) => Promise<boolean>;
};

export function failure(status: number, code: string, message: string, details?: Record<string, string | number>): Response {
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

export type GrantDeps = Pick<PortalCredentialDeps, "db" | "authorize">;

export async function holds(d: Pick<PortalCredentialDeps, "authorize">, principalId: string, tenantId: string, resource: string, action: string): Promise<boolean> {
  if (await d.authorize(principalId, tenantId, resource, action)) return true;
  return action === "read" && d.authorize(principalId, tenantId, resource, "use");
}

type CredentialAction = "read" | "use" | "manage";

/**
 * The credential `name` resolves to for the tenant, its own or an ancestor's, when it is active and workspace-owned. An
 * inactive or personal one is never passed over for an ancestor's. Its `tenantId` is the workspace whose host settings go with it.
 */
export async function activeCredential(db: DB["db"], tenantId: string, name: string) {
  const credential = await resolveCredentialByName(db, tenantId, name);
  return credential?.status === "active" && credential.principalId === null ? credential : undefined;
}

export function credentialSecret(cipher: CredentialCipher, credential: { id: string; secret: string }): Promise<string> {
  return cipher.decrypt(credential.secret, credentialAad(credential.id, "secret"));
}

/** As `activeCredential`, but an expired one too: GitHub's is still connected while its token is expired, and the hub acts with the App key. */
export async function heldCredential(db: DB["db"], tenantId: string, name: string) {
  const credential = await resolveCredentialByName(db, tenantId, name);
  return credential && credential.status !== "revoked" && credential.principalId === null ? credential : undefined;
}

/** Why a member may not act with a host's credential: 409 when neither the workspace nor a parent has one, the same for every member; 403 when this member lacks the grant. */
export type CredentialRefusal = { status: 403 | 409; code: string; message: string };

const HOST_CREDENTIAL = {
  github: { name: GITHUB_CREDENTIAL, label: "GitHub App", connect: "Connect GitHub first." },
  "bitbucket-datacenter": { name: TOKEN_CREDENTIAL, label: "Bitbucket Data Center", connect: "Connect Bitbucket Data Center first." },
} as const;

async function hostCredential(d: GrantDeps, principalId: string, tenantId: string, source: RepoSource, action: CredentialAction) {
  const host = HOST_CREDENTIAL[source];
  const credential = await heldCredential(d.db, tenantId, host.name);
  if (!credential) return { status: 409, code: `${source.replace("-", "_")}_not_connected`, message: host.connect } satisfies CredentialRefusal;
  if (!(await holds(d, principalId, tenantId, `credential:${credential.id}`, action))) {
    return { status: 403, code: "forbidden", message: `You do not have access to the ${host.label} credential.` } satisfies CredentialRefusal;
  }
  return credential;
}

export function refusalResponse(refusal: CredentialRefusal): Response {
  return failure(refusal.status, refusal.code, refusal.message);
}

/** The App credential's row when the member holds `action` on it, or the error response to return. Holding `use` also allows `read`. */
async function githubAppGrant(d: PortalCredentialDeps, principalId: string, tenantId: string, action: CredentialAction) {
  const credential = await hostCredential(d, principalId, tenantId, "github", action);
  return "code" in credential ? refusalResponse(credential) : credential;
}

/** Why the member may not hold `action` on the credential of the record's host, if they may not. */
export async function sourceCredentialRefusal(d: GrantDeps, principalId: string, tenantId: string, record: Pick<RepoRecord, "source">, action: CredentialAction): Promise<CredentialRefusal | undefined> {
  const credential = await hostCredential(d, principalId, tenantId, sourceOf(record), action);
  return "code" in credential ? credential : undefined;
}

/** Whether the member holds `action` on the credential of the record's host; a missing credential is a 409 naming the host. */
export async function sourceCredentialGrant(d: GrantDeps, principalId: string, tenantId: string, record: Pick<RepoRecord, "source">, action: CredentialAction): Promise<Response | undefined> {
  const refusal = await sourceCredentialRefusal(d, principalId, tenantId, record, action);
  return refusal && refusalResponse(refusal);
}

export type GithubApp = { appJson: string; login: string };

/** Members are granted the `github` credential; the hub acts for them with the App key behind it. */
export async function githubAppCredential(d: PortalCredentialDeps, principalId: string, tenantId: string, action: CredentialAction): Promise<GithubApp | Response> {
  const credential = await githubAppGrant(d, principalId, tenantId, action);
  if (credential instanceof Response) return credential;
  return { appJson: await githubAppKey(d, credential.tenantId), login: githubAppLogin(credential) };
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
  return githubUsage.gate(function appCredentialFetch(path, init) {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${appJson}`);
    // A read that asks for another media type, such as a pull request's diff, keeps it.
    if (!headers.has("accept")) headers.set("accept", "application/vnd.github+json");
    return appFetch(`${apiOrigin}${path}`, { ...init, headers });
  });
}
