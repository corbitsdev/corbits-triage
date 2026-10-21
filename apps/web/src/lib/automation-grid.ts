import { TRIAGE_ROLE } from "@corbits/triage-contracts";
import type { HubRole } from "./hub-api.ts";

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
