import { ANY_DO_RESOURCE, DO_GRANT_ACTION, doResource, TRIAGE_ROLE, type ActionKind } from "@corbits/triage-contracts";
import type { HubGrant, HubRole } from "./hub-api.ts";

export function findTriageRole(roles: readonly HubRole[]): HubRole | undefined {
  return roles.find(isTriageRole);
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
