import { ACTION_KINDS, ANY_DO_RESOURCE, DO_GRANT_ACTION, DO_GRANT_PREFIX, TRIAGE_ROLE, type ActionKind } from "@corbits/triage-contracts";
import type { HubGrant, HubRole } from "./hub-api.ts";

/** Agent Dos cannot run yet, so no one is granted them. */
export const GRID_KINDS = ACTION_KINDS.filter((kind) => kind !== "agent");

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

/** Owner and admin first, then the other roles, then what triage does on its own. */
export function gridRoles(roles: readonly HubRole[]): HubRole[] {
  function rank(role: HubRole): number {
    if (system(role, "owner")) return 0;
    if (system(role, "admin")) return 1;
    return system(role, TRIAGE_ROLE) ? 3 : 2;
  }
  return [...roles].sort((a, b) => rank(a) - rank(b));
}

export function roleColumnName(role: HubRole): string {
  return system(role, TRIAGE_ROLE) ? "Triage on its own" : role.name;
}

