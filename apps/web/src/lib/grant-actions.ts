import type { HubGrant, HubPrincipal, HubRole } from "./hub-api.ts";

export type GrantEffect = "allow" | "ask" | "deny";

export function parseGrantEffect(value: string): GrantEffect {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  throw new Error("Effect must be Allow, Ask, or Deny.");
}

export type CreateGrantInput = {
  principalId?: string | null;
  roleId?: string | null;
  resource: string;
  action: string;
  effect: GrantEffect;
};

export type CreateGrantBody = {
  principalId?: string;
  roleId?: string;
  resource: string;
  action: string;
  effect: GrantEffect;
  origin: "creator" | "role";
};

export type AccessWhoOption = {
  value: string;
  label: string;
  group: "People" | "Roles";
};

const ID_PATTERN = /^[a-z]{2,5}_[A-Za-z0-9]+$/;

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function looksLikeId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("@") || trimmed.includes(" ")) return false;
  return ID_PATTERN.test(trimmed);
}

export function canRemoveGrant(grant: Pick<HubGrant, "origin">): boolean {
  return grant.origin !== "system";
}

export function assertCanRemoveGrant(grant: Pick<HubGrant, "origin">): void {
  if (!canRemoveGrant(grant)) {
    throw new Error("This built-in rule cannot be removed.");
  }
}

export function createGrantBody(input: CreateGrantInput): CreateGrantBody {
  const principalId = trimOrNull(input.principalId);
  const roleId = trimOrNull(input.roleId);
  const resource = input.resource.trim();
  const action = input.action.trim();
  if (!resource) throw new Error("Resource is required.");
  if (!action) throw new Error("Action is required.");
  const targets = (principalId ? 1 : 0) + (roleId ? 1 : 0);
  if (targets !== 1) {
    throw new Error("Choose a person or a role, not both.");
  }
  if (principalId) {
    return { principalId, resource, action, effect: input.effect, origin: "creator" };
  }
  if (roleId) {
    return { roleId, resource, action, effect: input.effect, origin: "role" };
  }
  throw new Error("Choose a person or a role, not both.");
}

export function parseWhoSelection(value: string): { principalId?: string; roleId?: string } {
  const trimmed = value.trim();
  if (trimmed.startsWith("person:")) {
    const principalId = trimmed.slice("person:".length).trim();
    if (!principalId) throw new Error("Choose a person or an existing role.");
    return { principalId };
  }
  if (trimmed.startsWith("role:")) {
    const roleId = trimmed.slice("role:".length).trim();
    if (!roleId) throw new Error("Choose a person or an existing role.");
    return { roleId };
  }
  throw new Error("Choose a person or an existing role.");
}

export function grantCreateInputFromForm(form: {
  who: string;
  resource: string;
  action: string;
  effect: GrantEffect;
}): CreateGrantInput {
  return {
    ...parseWhoSelection(form.who),
    resource: form.resource,
    action: form.action,
    effect: form.effect,
  };
}

function displayOrFallback(value: string | null | undefined, fallback: string): string {
  const trimmed = trimOrNull(value);
  if (!trimmed || looksLikeId(trimmed)) return fallback;
  return trimmed;
}

export function grantWhoLabel(
  grant: HubGrant,
  people: readonly HubPrincipal[] = [],
  roles: readonly HubRole[] = [],
): string {
  const roleId = trimOrNull(grant.roleId);
  if (roleId) {
    const named = roles.find((role) => role.id === roleId)?.name;
    return displayOrFallback(named ?? grant.roleName, "Role");
  }
  const principalId = trimOrNull(grant.principalId);
  if (principalId) {
    const person = people.find((row) => row.id === principalId);
    const email = trimOrNull(person?.email);
    if (email && !looksLikeId(email)) return email;
    return displayOrFallback(grant.principalName ?? person?.displayName, "Person");
  }
  return displayOrFallback(grant.principalName ?? grant.roleName, "Unknown");
}

const RESOURCE_KIND_LABELS: Record<string, string> = {
  "workflow-run": "Workflow run",
  credential: "Secret",
  tool: "Tool",
  asset: "Asset",
  grant: "Access rule",
  role: "Role",
};

export function grantResourceLabel(resource: string): { label: string; detail: string } {
  const trimmed = resource.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return { label: trimmed, detail: trimmed };
  const kind = trimmed.slice(0, colon);
  const known = RESOURCE_KIND_LABELS[kind];
  if (!known) return { label: trimmed, detail: trimmed };
  return { label: known, detail: trimmed };
}

export function accessWhoOptions(
  people: readonly HubPrincipal[],
  roles: readonly HubRole[],
): AccessWhoOption[] {
  const personOptions: AccessWhoOption[] = [];
  for (const person of people) {
    if (person.kind && person.kind !== "user") continue;
    if (person.status && person.status.toLowerCase() !== "active") continue;
    const label = displayOrFallback(person.email, displayOrFallback(person.displayName, "Member"));
    personOptions.push({ value: `person:${person.id}`, label, group: "People" });
  }
  const roleOptions: AccessWhoOption[] = [];
  for (const role of roles) {
    const label = displayOrFallback(role.name, "Role");
    roleOptions.push({ value: `role:${role.id}`, label, group: "Roles" });
  }
  return [...personOptions, ...roleOptions];
}
