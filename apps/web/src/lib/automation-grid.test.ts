import { describe, expect, test } from "bun:test";
import { gridCell, triageRunsAlone } from "./automation-grid.ts";
import type { HubGrant } from "./hub-api.ts";

const TRIAGE = { id: "rol_triage", name: "pr-triage", isSystem: true };

function grant(id: string, resource: string): HubGrant {
  return { id, resource, action: "invoke", effect: "allow", roleId: TRIAGE.id };
}

describe("automation grid", () => {
  test("a role's per-repository grants show the cell on, list the repositories, and are what turning it off removes", () => {
    const grants = [grant("g1", "triage-do:comment:acme/api"), grant("g2", "triage-do:comment:*"), grant("g3", "triage-do:labels:acme/api")];
    expect(gridCell(TRIAGE, "comment", grants)).toEqual({ granted: true, locked: false, grants: [grants[0], grants[1]], repos: ["acme/api"] });
    expect(gridCell(TRIAGE, "close", grants)).toEqual({ granted: false, locked: false, grants: [], repos: [] });
  });

  test("triage runs a Do alone only on the repositories its role is granted the kind on", () => {
    const grants = [grant("g1", "triage-do:comment:acme/api"), grant("g2", "triage-do:labels:*")];
    expect(triageRunsAlone([TRIAGE], grants, "comment", "Acme/API")).toBe(true);
    expect(triageRunsAlone([TRIAGE], grants, "comment", "acme/web")).toBe(false);
    expect(triageRunsAlone([TRIAGE], grants, "labels", "acme/web")).toBe(true);
    expect(triageRunsAlone([], grants, "labels", "acme/web")).toBe(false);
  });
});
