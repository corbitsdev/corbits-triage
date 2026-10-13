import type { HubGrant } from "./hub-api.ts";

/** The portal only allows a role something; other grants go through the stock grant routes. */
export type CreateGrantInput = { roleId: string; resource: string; action: string };

export type CreateGrantBody = CreateGrantInput & { effect: "allow"; origin: "role" };

export function canRemoveGrant(grant: Pick<HubGrant, "origin">): boolean {
  return grant.origin !== "system";
}

export function assertCanRemoveGrant(grant: Pick<HubGrant, "origin">): void {
  if (!canRemoveGrant(grant)) {
    throw new Error("This built-in rule cannot be removed.");
  }
}

export function createGrantBody(input: CreateGrantInput): CreateGrantBody {
  return { roleId: input.roleId, resource: input.resource, action: input.action, effect: "allow", origin: "role" };
}
