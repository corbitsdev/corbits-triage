import { describe, expect, test } from "bun:test";
import { CATALOG_IDS, catalogCheckEnabled, classificationSources, DEFAULT_REPO_POLICY, emptyPack, readCheckPack, recommendedPack, type CheckPack, type CustomCheck, type PolicyActions, type Step } from "@corbits/triage-contracts";
import { freshStepId, fromPack, packChanges, savable, setCatalogCheck, setCustomEnabled, setSteps, stepEntries, toPack, validate } from "./pack-draft.ts";

const repo = "acme/widgets";

const custom: CustomCheck[] = [
  { id: "custom-1", name: "Reversible", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "The migration can be rolled back.", scope: "file", when: ["migrations/**"] },
  { id: "custom-2", name: "Clarity", group: "pull-request", kind: "model", shape: "score", subject: "description clarity", levels: ["poor", "fair", "good"], failBelow: "fair" },
  { id: "custom-3", name: "Risk", group: "around", kind: "model", shape: "choose", options: ["low", "high"], failOn: ["high"] },
  { id: "custom-8", name: "Public API", group: "pull-request", kind: "model", shape: "is-true", claim: "The change alters a public API." },
];

const everyDo: Step[] = [
  { do: "labels", target: { from: "list", labels: ["needs-review"] } },
  { do: "labels", target: { from: "rules" }, for: "maintainers" },
  { do: "assign", target: { to: "users", users: ["octocat"] } },
  { do: "assign", target: { to: "teams", teams: ["core"] } },
  { do: "assign", target: { to: "codeowners" } },
  { do: "assign", target: { to: "author" } },
  { do: "request-review", target: { to: "codeowners" }, for: { team: "acme/core" } },
  { do: "comment", target: { body: "Thanks!" }, for: { users: ["octocat"] } },
  { do: "close", for: "bots" },
  { do: "merge" },
  { do: "nothing", for: "first-timers" },
];

const actions: PolicyActions = { when: ["opened", "ready"], pass: everyDo, fail: everyDo, unsure: [{ do: "close" }] };

function pack(overrides: Partial<CheckPack>): CheckPack {
  return { ...emptyPack(repo), ...overrides };
}

const policy = DEFAULT_REPO_POLICY;

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
      expect(packChanges(draft.pack, readCheckPack(JSON.stringify(stored)))).toBe(0);
      expect(validate(draft, draft)).toBeNull();
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

  test("each verdict list is one change; a new unfinished step waits, and a saved one mid-edit keeps its saved version", () => {
    const saved = fromPack(packs["every Do target"]!, policy);
    expect(packChanges(saved.pack, setSteps(setSteps(saved, "pass", []), "fail", []).pack)).toBe(2);
    const added = setSteps(saved, "unsure", [...stepEntries(saved, "unsure"), { id: freshStepId(), step: { do: "comment", target: { body: " " } } }]);
    expect(savable(added, saved).pack.actions.unsure).toEqual(saved.pack.actions.unsure);
    const [first, ...rest] = stepEntries(saved, "pass");
    const emptied = setSteps(saved, "pass", [{ id: first!.id, step: { do: "comment", target: { body: "" } } }, ...rest]);
    expect(savable(emptied, saved).pack.actions.pass).toEqual(saved.pack.actions.pass);
  });

  test("an unfinished rule mid-edit keeps its saved version", () => {
    const stored = pack({ custom });
    const saved = fromPack(stored, policy);
    const row = stored.custom[0]!;
    const emptied = { ...saved, pack: { ...stored, custom: stored.custom.map((item) => (item.id === row.id && item.shape === "is-true" ? { ...item, claim: "" } : item)) } };
    expect(savable(emptied, saved).pack.custom).toEqual(stored.custom);
  });

  test("switching a custom check off keeps it in the pack but out of evaluation, and back on restores the saved row", () => {
    const stored = pack({ custom });
    const saved = fromPack(stored, policy);
    const off = setCustomEnabled(saved, "custom-8", false);
    expect(packChanges(saved.pack, off.pack)).toBe(1);
    const read = readCheckPack(JSON.stringify(toPack(off)));
    expect(read.custom.find((row) => row.id === "custom-8")?.enabled).toBe(false);
    expect(classificationSources(read).custom.map((row) => row.id)).not.toContain("custom-8");
    expect(setCustomEnabled(off, "custom-8", true).pack).toEqual(stored);
  });
});
