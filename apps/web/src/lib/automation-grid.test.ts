import { describe, expect, test } from "bun:test";
import { hostCased, triageScope } from "./automation-grid.ts";
import type { HubGrant } from "./hub-api.ts";

const TRIAGE = { id: "rol_triage", name: "pr-triage", isSystem: true };

function grant(id: string, resource: string): HubGrant {
  return { id, resource, action: "invoke", effect: "allow", roleId: TRIAGE.id };
}

describe("automation grid", () => {
  test("triage's scope for a kind pairs each repository with the grant to remove, apart from its everywhere grant", () => {
    const grants = [grant("g1", "triage-do:comment:acme/api"), grant("g2", "triage-do:comment:*"), grant("g3", "triage-do:labels:acme/web")];
    expect(triageScope(TRIAGE, "comment", grants)).toEqual({ locked: false, everywhere: grants[1], repos: [{ repo: "acme/api", grant: grants[0] }] });
    expect(triageScope(TRIAGE, "comment", [grant("g4", "triage-do:*")])).toEqual({ locked: true, everywhere: undefined, repos: [] });
  });

  test("a repository a grant names lowercased reads with the host's casing", () => {
    expect(hostCased(["TRI/widgets"], "tri/widgets")).toBe("TRI/widgets");
    expect(hostCased(["TRI/widgets"], "acme/gone")).toBe("acme/gone");
  });
});
