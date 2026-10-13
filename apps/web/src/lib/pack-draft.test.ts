import { describe, expect, test } from "bun:test";
import { CATALOG_IDS, catalogCheckEnabled, classificationSources, DEFAULT_REPO_POLICY, emptyPack, readCheckPack, recommendedPack, type CheckPack, type CustomCheck, type Do, type PolicyActions } from "@corbits/triage-contracts";
import { changeCount, fromPack, setCatalogCheck, setCustomEnabled, setList, setWhen, toPack, validate } from "./pack-draft.ts";

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
  { kind: "labels", target: { from: "list", labels: ["needs-review"] } },
  { kind: "labels", target: { from: "type" } },
  { kind: "labels", target: { from: "paths" } },
  { kind: "assign", target: { to: "users", users: ["octocat"] } },
  { kind: "assign", target: { to: "teams", teams: ["core"] } },
  { kind: "assign", target: { to: "role", role: "maintainers" } },
  { kind: "assign", target: { to: "codeowners" } },
  { kind: "assign", target: { to: "author" } },
  { kind: "request-review", target: { to: "codeowners" } },
  { kind: "comment", target: { body: "Thanks!" } },
  { kind: "close", target: {} },
  { kind: "agent", target: { prompt: "Fix the lint errors.", tools: ["github"] } },
];

const actions: PolicyActions = { when: ["opened", "ready"], pass: everyDo, fail: everyDo, unsure: [{ kind: "close", target: {} }] };

function pack(overrides: Partial<CheckPack>): CheckPack {
  return { ...emptyPack(repo), ...overrides };
}

const policy = { ...DEFAULT_REPO_POLICY, roles: { maintainers: { users: ["octocat"] } } };

const packs: Record<string, CheckPack> = {
  recommended: recommendedPack(repo),
  "no optional catalog keys": pack({ checks: { "max-files-changed": { enabled: true }, "linked-issue": { enabled: false }, "no-forbidden-paths": { enabled: true } } }),
  "every Do target": pack({ checks: recommendedPack(repo).checks, custom, actions }),
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

  test("the policy's when and each verdict list are one change apiece, and a list naming an undefined role is refused there", () => {
    const saved = fromPack(packs["every Do target"]!, policy);
    expect(changeCount(saved, setWhen(saved, ["opened"]))).toBe(1);
    expect(changeCount(saved, setList(setList(saved, "pass", []), "fail", []))).toBe(2);
    const ghost = setList(saved, "unsure", [{ kind: "request-review", target: { to: "role", role: "ghost" } }]);
    expect(validate(ghost)).toEqual({ reason: "Actions unsure targets role ghost, which this repository does not define.", where: { section: "actions", list: "unsure" } });
  });

  test("switching a custom check off keeps it in the pack but out of evaluation, and back on restores the saved row", () => {
    const stored = pack({ custom });
    const saved = fromPack(stored, policy);
    const off = setCustomEnabled(saved, "custom-8", false);
    expect(changeCount(saved, off)).toBe(1);
    const read = readCheckPack(JSON.stringify(toPack(off)));
    expect(read.custom.find((row) => row.id === "custom-8")?.enabled).toBe(false);
    expect(classificationSources(read).custom).toEqual([]);
    expect(classificationSources(setCustomEnabled(saved, "custom-1", false).pack).rules.map((row) => row.id)).not.toContain("custom-1");
    expect(setCustomEnabled(off, "custom-8", true).pack).toEqual(stored);
  });
});
