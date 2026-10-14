import { ACTION_KINDS, ANY_DO_RESOURCE, DO_GRANT_ACTION, DO_GRANT_PREFIX, doResource, TRIAGE_ROLE, type ActionKind } from "@corbits/triage-contracts";
import type { HubGrant, HubRole } from "./hub-api.ts";

export const GRID_KINDS = ACTION_KINDS;

/**
 * `grants` are the role's grants of the kind, on every repository (`*`) or on some; `repos` names those some. Turning
 * a cell off removes them all. A locked cell holds the kind through a wider grant and cannot change here.
 */
export type GridCell = { granted: boolean; locked: boolean; grants: HubGrant[]; repos: string[] };

function system(role: HubRole, name: string): boolean {
  return role.isSystem === true && role.name === name;
}

export function gridCell(role: HubRole, kind: ActionKind, grants: readonly HubGrant[]): GridCell {
  if (system(role, "owner")) return { granted: true, locked: true, grants: [], repos: [] };
  const held = grants.filter((grant) => grant.roleId === role.id && grant.action === DO_GRANT_ACTION && grant.effect === "allow");
  if (held.some((grant) => grant.resource === ANY_DO_RESOURCE)) return { granted: true, locked: true, grants: [], repos: [] };
  const prefix = `${DO_GRANT_PREFIX}:${kind}:`;
  const own = held.filter((grant) => grant.resource.startsWith(prefix));
  const repos = own.map((grant) => grant.resource.slice(prefix.length)).filter((repo) => repo !== "*");
  return { granted: own.length > 0, locked: false, grants: own, repos };
}

export function gridRoles(roles: readonly HubRole[]): HubRole[] {
  function rank(role: HubRole): number {
    if (system(role, "owner")) return 0;
    return system(role, "admin") ? 1 : 2;
  }
  return roles.filter((role) => !isTriageRole(role)).sort((a, b) => rank(a) - rank(b));
}

export function findTriageRole(roles: readonly HubRole[]): HubRole | undefined {
  return roles.find((role) => system(role, TRIAGE_ROLE));
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

export function triageRunsAlone(roles: readonly HubRole[], grants: readonly HubGrant[], kind: ActionKind, repo: string): boolean {
  const triage = findTriageRole(roles);
  if (!triage) return false;
  const resources = [ANY_DO_RESOURCE, doResource(kind, "*"), doResource(kind, repo)];
  return grants.some((grant) => grant.roleId === triage.id && grant.action === DO_GRANT_ACTION && grant.effect === "allow" && resources.includes(grant.resource));
}
