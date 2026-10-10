import { describe, expect, test } from "bun:test";
import { CATALOG_IDS, catalogCheckEnabled, DEFAULT_REPO_POLICY, emptyPack, readCheckPack, recommendedPack, type Action, type CheckPack, type CustomCheck, type Do } from "@corbits/triage-contracts";
import { changeCount, fromPack, removeCustom, setCatalogCheck, toPack, upsertAction, validate } from "./pack-draft.ts";

const repo = "acme/widgets";

const custom: CustomCheck[] = [
  { id: "custom-1", name: "Untouched lockfile", group: "code-vs-ci", kind: "rule", rule: "paths-unchanged", globs: ["bun.lock"] },
  { id: "custom-2", name: "Schema with migration", group: "code-vs-ci", kind: "rule", rule: "paths-together", changed: ["schema/**"], requires: ["migrations/**"] },
  { id: "custom-3", name: "Conventional title", group: "pull-request", kind: "rule", rule: "title-pattern", pattern: "^(feat|fix)" },
  { id: "custom-4", name: "Branch name", group: "pull-request", kind: "rule", rule: "branch-pattern", pattern: "^cl-\\d+" },
  { id: "custom-5", name: "Triaged label", group: "issue", kind: "rule", rule: "label-required", label: "triaged" },
  { id: "custom-6", name: "No debugger", group: "code-vs-ci", kind: "rule", rule: "diff-excludes", pattern: "debugger" },
  { id: "custom-7", name: "Two approvals", group: "around", kind: "rule", rule: "min-approvals", count: 2 },
  { id: "custom-8", name: "Public API", group: "pull-request", kind: "model", shape: "is-true", claim: "The change alters a public API." },
];

const everyDo: Do[] = [
  { kind: "labels", automatic: true, target: { from: "list", labels: ["needs-review"] } },
  { kind: "labels", automatic: true, target: { from: "type" } },
  { kind: "labels", automatic: false, target: { from: "paths" } },
  { kind: "assign", automatic: false, target: { to: "users", users: ["octocat"] } },
  { kind: "assign", automatic: false, target: { to: "teams", teams: ["core"] } },
  { kind: "assign", automatic: false, target: { to: "role", role: "maintainers" } },
  { kind: "assign", automatic: false, target: { to: "codeowners" } },
  { kind: "assign", automatic: false, target: { to: "author" } },
  { kind: "request-review", automatic: true, target: { to: "codeowners" } },
  { kind: "comment", automatic: true, target: { body: "Thanks!" } },
  { kind: "close", automatic: false, target: {} },
  { kind: "agent", automatic: false, target: { prompt: "Fix the lint errors.", tools: ["github"] } },
];

const actions: Action[] = [
  { id: "action-1", when: "every", checks: [], branches: { always: [{ kind: "comment", automatic: true, target: { body: "Welcome." } }] } },
  { id: "action-2", when: ["opened", "updated"], checks: ["size"], branches: { yes: [{ kind: "labels", automatic: true, target: { from: "type" } }] } },
  { id: "action-3", when: "every", checks: ["ci", "custom-8"], branches: { yes: everyDo, no: everyDo, unsure: everyDo.filter((step) => step.kind !== "close") } },
  { id: "action-4", when: ["ready", "reviewed"], checks: ["custom-8"], branches: { yes: everyDo, no: [], unsure: [{ kind: "close", automatic: false, target: {} }] } },
];

function pack(overrides: Partial<CheckPack>): CheckPack {
  return { ...emptyPack(repo), ...overrides };
}

const policy = { ...DEFAULT_REPO_POLICY, roles: { maintainers: { users: ["octocat"] } } };

const packs: Record<string, CheckPack> = {
  recommended: recommendedPack(repo),
  "no optional catalog keys": pack({ checks: { size: { enabled: true }, issue: { enabled: false }, drift: { enabled: true }, paths: { enabled: true } } }),
  "every action form and Do target": pack({ checks: recommendedPack(repo).checks, custom, actions }),
};

describe("pack draft", () => {
  for (const [name, stored] of Object.entries(packs)) {
    test(`round trips ${name} unchanged`, () => {
      const draft = fromPack(stored, policy);
      expect(readCheckPack(toPack(draft))).toEqual(stored);
      expect(changeCount(draft, fromPack(readCheckPack(JSON.stringify(stored)), policy))).toBe(0);
      expect(validate(draft)).toBeNull();
    });
  }

  test("toggling a catalog check back restores the saved row, present or absent", () => {
    for (const stored of Object.values(packs)) {
      const saved = fromPack(stored, policy);
      for (const id of CATALOG_IDS) {
        const enabled = catalogCheckEnabled(stored, id);
        const back = setCatalogCheck(setCatalogCheck(saved, stored, id, { enabled: !enabled }), stored, id, { enabled });
        expect(back.pack).toEqual(stored);
      }
    }
  });

  test("editing one action is one change", () => {
    const saved = fromPack(packs["every action form and Do target"]!, policy);
    const edited = upsertAction(saved, { ...actions[1]!, when: ["opened"] });
    expect(changeCount(saved, edited)).toBe(1);
  });

  test("removing a custom check detaches it from actions, and refuses when that leaves branches with no checks", () => {
    const saved = fromPack(pack({ custom, actions: [actions[0]!, actions[2]!] }), policy);
    const removed = removeCustom(saved, "custom-8");
    if ("reason" in removed) throw new Error(removed.reason);
    expect(removed.pack.custom.map((row) => row.id)).not.toContain("custom-8");
    expect(removed.pack.actions[1]!.checks).toEqual(["ci"]);
    expect(validate(removed)).toBeNull();
    const only = fromPack(pack({ custom, actions: [actions[3]!] }), policy);
    expect(removeCustom(only, "custom-8")).toEqual({ reason: "Action action-4 checks only custom-8. Give it another check or remove the action first." });
  });
});
