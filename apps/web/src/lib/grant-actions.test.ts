import { describe, expect, test } from "bun:test";
import type { HubGrant } from "./hub-api.ts";
import { canRemoveGrant } from "./grant-actions.ts";

const grant = (overrides: Partial<HubGrant>): HubGrant => ({
  id: "grn_1",
  tenantId: "tnt",
  resource: "workflow-run:*",
  action: "read",
  effect: "allow",
  origin: "creator",
  principalId: null,
  principalName: null,
  roleId: null,
  roleName: null,
  createdAt: "2026-03-10T00:00:00.000Z",
  updatedAt: "2026-03-10T00:00:00.000Z",
  ...overrides,
});

describe("system-origin grants", () => {
  test("cannot be removed", () => {
    expect(canRemoveGrant(grant({ origin: "system" }))).toBe(false);
    expect(canRemoveGrant(grant({ origin: "creator" }))).toBe(true);
    expect(canRemoveGrant(grant({ origin: "role" }))).toBe(true);
  });
});
