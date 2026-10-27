import { describe, expect, test } from "bun:test";
import { DEFAULT_REPO_POLICY, emptyPack, readCheckPack, recommendedPack, type CheckPack, type CustomCheck, type PolicyActions, type Step } from "@corbits/triage-contracts";
import { freshStepId, fromPack, packChanges, savable, setSteps, stepEntries, toPack, validate } from "./pack-draft.ts";

const repo = "acme/widgets";

const custom: CustomCheck[] = [
  { id: "custom-1", name: "Reversible", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "The migration can be rolled back.", scope: "file", when: ["migrations/**"] },
  { id: "custom-2", name: "Clarity", group: "pull-request", kind: "model", shape: "score", subject: "description clarity", levels: ["poor", "fair", "good"], failBelow: "fair" },
  { id: "custom-3", name: "Risk", group: "around", kind: "model", shape: "choose", options: ["low", "high"], failOn: ["high"] },
  { id: "custom-8", name: "Public API", group: "pull-request", kind: "model", shape: "is-true", claim: "The change alters a public API." },
];

const everyDo: Step[] = [
  { do: "labels", target: { from: "list", labels: ["needs-review"] } },
  { do: "labels", target: { from: "rules" }, when: { author: ["OWNER", "MEMBER", "COLLABORATOR"] } },
  { do: "assign", target: { to: "users", users: ["octocat"] } },
  { do: "assign", target: { to: "teams", teams: ["core"] } },
  { do: "assign", target: { to: "codeowners" } },
  { do: "assign", target: { to: "author" } },
  { do: "request-review", target: { to: "codeowners" }, when: { author: [{ team: "acme/core" }] } },
  { do: "comment", target: { body: "Thanks!" }, when: { author: [{ users: ["octocat"] }] } },
  { do: "close", when: { author: ["BOT"] } },
  { do: "merge" },
  { do: "nothing", when: { author: ["FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"] } },
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

  test("each verdict list is one change; a new unfinished step waits, and a saved one mid-edit keeps its saved version", () => {
    const saved = fromPack(packs["every Do target"]!, policy);
    expect(packChanges(saved.pack, setSteps(setSteps(saved, "pass", []), "fail", []).pack)).toBe(2);
    const added = setSteps(saved, "unsure", [...stepEntries(saved, "unsure"), { id: freshStepId(), step: { do: "comment", target: { body: " " } } }]);
    expect(savable(added, saved).pack.actions.unsure).toEqual(saved.pack.actions.unsure);
    const [first, ...rest] = stepEntries(saved, "pass");
    const emptied = setSteps(saved, "pass", [{ id: first!.id, step: { do: "comment", target: { body: "" } } }, ...rest]);
    expect(savable(emptied, saved).pack.actions.pass).toEqual(saved.pack.actions.pass);
  });

  test("a blank or too long verdict label keeps its saved name, and a step past the last a verdict holds waits", () => {
    const saved = fromPack(pack({}), policy);
    const named = { ...saved, pack: { ...saved.pack, labels: { ...saved.pack.labels, pass: " ", fail: "x".repeat(51), unsure: "Triage: Look" } } };
    expect(savable(named, saved).pack.labels).toEqual({ ...saved.pack.labels, unsure: "Triage: Look" });
    const many = setSteps(saved, "pass", Array.from({ length: 21 }, (_, i) => ({ id: freshStepId(), step: { do: "comment" as const, target: { body: `note ${i}` } } })));
    expect(savable(many, saved).pack.actions.pass).toHaveLength(20);
  });

  test("an unfinished rule mid-edit keeps its saved version", () => {
    const stored = pack({ custom });
    const saved = fromPack(stored, policy);
    const row = stored.custom[0]!;
    const emptied = { ...saved, pack: { ...stored, custom: stored.custom.map((item) => (item.id === row.id && item.kind === "model" && item.shape === "is-true" ? { ...item, claim: "" } : item)) } };
    expect(savable(emptied, saved).pack.custom).toEqual(stored.custom);
  });
});
