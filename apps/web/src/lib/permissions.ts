import { grantResourceLabel } from "./grant-actions.ts";
import type { HubGrant } from "./hub-api.ts";

export type Permission = { label: string; resource: string; action: string };

export function permissionCatalog(githubCredentialId: string | null): Permission[] {
  return [
    { label: "View everything", resource: "*", action: "read" },
    // The hub's GitHub routes check `use` on the App credential.
    ...(githubCredentialId ? [{ label: "Act on GitHub", resource: `credential:${githubCredentialId}`, action: "use" }] : []),
    { label: "Create anything", resource: "*", action: "create" },
    { label: "Change and delete anything", resource: "*", action: "manage" },
    { label: "Do everything", resource: "*", action: "*" },
  ];
}

/** A known permission's name, or the resource kind and action with the exact resource, so two secrets stay distinct. */
export function describePermission(
  grant: Pick<HubGrant, "resource" | "action">,
  catalog: readonly Permission[],
): { label: string; resource?: string } {
  const known = catalog.find((permission) => permission.resource === grant.resource && permission.action === grant.action);
  if (known) return { label: known.label };
  return { label: `${grantResourceLabel(grant.resource).label}: ${grant.action}`, resource: grant.resource };
}
