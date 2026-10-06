import { describe, expect, test } from "bun:test";
import type { HubGrant, HubPrincipal, HubRole } from "./hub-api.ts";
import {
  accessWhoOptions,
  canRemoveGrant,
  createGrantBody,
  grantCreateInputFromForm,
  grantWhoLabel,
} from "./grant-actions.ts";

const grant = (overrides: Partial<HubGrant>): HubGrant => ({
  id: "grn_1",
  resource: "workflow-run:*",
  action: "read",
  effect: "allow",
  origin: "creator",
  principalId: null,
  principalName: null,
  roleId: null,
  roleName: null,
  ...overrides,
});

const people: HubPrincipal[] = [
  { id: "prn_ada", kind: "user", status: "active", displayName: "Ada", email: "ada@example.com" },
  { id: "prn_bot", kind: "workflow", status: "active", displayName: "Bot", email: "bot@example.com" },
];

const roles: HubRole[] = [
  { id: "rol_owner", name: "Owner", isSystem: true },
  { id: "rol_custom", name: "Reviewer" },
];

describe("system-origin grants", () => {
  test("cannot be removed", () => {
    expect(canRemoveGrant(grant({ origin: "system" }))).toBe(false);
    expect(canRemoveGrant(grant({ origin: "creator" }))).toBe(true);
    expect(canRemoveGrant(grant({ origin: "role" }))).toBe(true);
  });
});

describe("createGrant body", () => {
  test("sends exactly one person target with origin creator, never system", () => {
    const body = createGrantBody({
      principalId: "prn_ada",
      resource: "workflow-run:*",
      action: "read",
      effect: "allow",
    });
    expect(body).toEqual({
      principalId: "prn_ada",
      resource: "workflow-run:*",
      action: "read",
      effect: "allow",
      origin: "creator",
    });
    expect(body).not.toHaveProperty("roleId");
    expect(body.origin).not.toBe("system");
  });

  test("sends exactly one role target with origin role, never system", () => {
    const body = createGrantBody({
      roleId: "rol_owner",
      resource: "grant:*",
      action: "manage",
      effect: "ask",
    });
    expect(body).toEqual({
      roleId: "rol_owner",
      resource: "grant:*",
      action: "manage",
      effect: "ask",
      origin: "role",
    });
    expect(body).not.toHaveProperty("principalId");
    expect(body.origin).not.toBe("system");
  });

  test("rejects both targets, neither target, and empty fields", () => {
    expect(() =>
      createGrantBody({ principalId: "prn_ada", roleId: "rol_owner", resource: "x", action: "read", effect: "allow" }),
    ).toThrow("Choose a person or a role, not both.");
    expect(() => createGrantBody({ resource: "x", action: "read", effect: "deny" })).toThrow(
      "Choose a person or a role, not both.",
    );
    expect(() => createGrantBody({ principalId: "prn_ada", resource: "  ", action: "read", effect: "allow" })).toThrow(
      "Resource is required.",
    );
  });

  test("form who selection maps to creator or role origin", () => {
    expect(
      createGrantBody(
        grantCreateInputFromForm({
          who: "person:prn_ada",
          resource: "tool:*",
          action: "invoke",
          effect: "deny",
        }),
      ).origin,
    ).toBe("creator");
    expect(
      createGrantBody(
        grantCreateInputFromForm({
          who: "role:rol_owner",
          resource: "tool:*",
          action: "invoke",
          effect: "deny",
        }),
      ).origin,
    ).toBe("role");
  });
});

describe("access who labels", () => {
  test("shows email or role name, never an id", () => {
    expect(
      grantWhoLabel(
        grant({ principalId: "prn_ada", principalName: "prn_ada" }),
        people,
        roles,
      ),
    ).toBe("ada@example.com");
    expect(
      grantWhoLabel(grant({ origin: "role", roleId: "rol_owner", roleName: "Owner" }), people, roles),
    ).toBe("Owner");
    expect(grantWhoLabel(grant({ principalId: "prn_missing", principalName: "prn_missing" }))).toBe("Person");
    expect(grantWhoLabel(grant({ roleId: "rol_missing", roleName: "rol_missing" }))).toBe("Role");

    const who = grantWhoLabel(
      grant({ principalId: "prn_ada", principalName: "Ada Lovelace" }),
      people,
      roles,
    );
    expect(who).not.toContain("prn_");
    expect(who).not.toContain("rol_");
    expect(who).not.toContain("grn_");
  });

  test("who picker labels are emails and role names", () => {
    const options = accessWhoOptions(people, roles);
    expect(options.map((option) => option.label)).toEqual(["ada@example.com", "Owner", "Reviewer"]);
    expect(options.some((option) => option.label.includes("prn_") || option.label.includes("rol_"))).toBe(false);
    expect(options.filter((option) => option.group === "People")).toHaveLength(1);
  });
});
