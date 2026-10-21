/** The portal only allows a role something; other grants go through the stock grant routes. */
export type CreateGrantInput = { roleId: string; resource: string; action: string };

export type CreateGrantBody = CreateGrantInput & { effect: "allow"; origin: "role" };

export function createGrantBody(input: CreateGrantInput): CreateGrantBody {
  return { roleId: input.roleId, resource: input.resource, action: input.action, effect: "allow", origin: "role" };
}
