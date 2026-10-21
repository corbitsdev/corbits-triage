import { ANY_DO_RESOURCE, DO_GRANT_ACTION, DO_GRANT_PREFIX, doResource, TRIAGE_ROLE, type ActionKind } from "@corbits/triage-contracts";
import type { HubGrant, HubRole } from "./hub-api.ts";

/** Grants name a repository lowercased; `repos` gives it back the host's casing. */
export function hostCased(repos: readonly string[], repo: string): string {
  return repos.find((name) => name.toLowerCase() === repo) ?? repo;
}

export function findTriageRole(roles: readonly HubRole[]): HubRole | undefined {
  return roles.find(isTriageRole);
}

/**
 * Where triage runs `kind` without asking. `locked` when a grant of every kind covers it, which cannot change here;
 * `everywhere` is the kind's `*` grant; `repos` pairs each named repository with the grant that names it.
 */
export type TriageScope = { locked: boolean; everywhere: HubGrant | undefined; repos: { repo: string; grant: HubGrant }[] };

export function triageScope(triage: HubRole, kind: ActionKind, grants: readonly HubGrant[]): TriageScope {
  const held = grants.filter((grant) => grant.roleId === triage.id && grant.action === DO_GRANT_ACTION && grant.effect === "allow");
  const prefix = `${DO_GRANT_PREFIX}:${kind}:`;
  const everywhere = doResource(kind, "*");
  const own = held.filter((grant) => grant.resource.startsWith(prefix));
  return {
    locked: held.some((grant) => grant.resource === ANY_DO_RESOURCE),
    everywhere: own.find((grant) => grant.resource === everywhere),
    repos: own.filter((grant) => grant.resource !== everywhere).map((grant) => ({ repo: grant.resource.slice(prefix.length), grant })),
  };
}

type NamedRole = { name: string; isSystem?: boolean };

export function isTriageRole(role: NamedRole): boolean {
  return role.isSystem === true && role.name === TRIAGE_ROLE;
}

export function roleName(role: NamedRole): string {
  return role.name.charAt(0).toUpperCase() + role.name.slice(1);
}
