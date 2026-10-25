import { describe, expect, test } from "bun:test";
import {
  emptyPack,
  exportPolicyFile,
  policyDifferences,
  readCheckPack,
  readPolicyFile,
  recommendedPack,
  VERDICTS,
  type CheckPack,
} from "@corbits/triage-contracts";
import { evaluateActions } from "./actions.js";
import type { PrFacts } from "./checks.js";
import { NO_FACTS } from "./item.js";

const REPO = "acme/widgets";

const facts: PrFacts = { ...NO_FACTS, repo: REPO, number: 8, author: "octocat", authorKind: "MEMBER", headSha: "abc", state: "open", mergeable: true, checks: "success", events: ["opened"] };

const everyStep: CheckPack = {
  ...emptyPack(REPO),
  checks: {
    "max-files-changed": { enabled: true, maxFiles: 25 },
    "max-lines-changed": { enabled: false, maxLines: 900 },
    "linked-issue": { enabled: true, tracker: "linear" },
    "no-forbidden-paths": { enabled: true, forbiddenGlobs: ["vendor/**", ".github/**"], text: "Never touch vendored code.", reason: "Vendored code is synced by a bot.", evidence: ["#12"] },
    "ci-green": { enabled: true },
  },
  custom: [
    { id: "errors-are-handled", name: "Errors are handled", group: "pull-request", kind: "model", shape: "is-true", claim: "Every new call that can fail handles its error." },
    { id: "no-trailers", name: "No trailers", group: "pull-request", kind: "text", enabled: false, fields: ["title", "commits"], failWhen: "not-contains", phrases: ["Signed-off-by:"] },
  ],
  actions: {
    when: ["opened", "ready"],
    pass: [
      { do: "approve", when: { author: ["OWNER", "MEMBER", "COLLABORATOR"], ci: ["passing"] } },
      { do: "merge", when: { author: ["BOT", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"], linkedIssue: true, files: { atMost: 5 }, lines: { over: 1, atMost: 200 } } },
      { do: "labels", target: { from: "list", labels: ["ready"] } },
    ],
    fail: [
      { do: "request-changes" },
      { do: "comment", target: { body: "Please split this.\nThanks." }, when: { author: [{ team: "core" }, { users: ["octocat"] }] } },
      { do: "close", when: { author: ["NONE"], linkedIssue: false } },
      { do: "labels", target: { from: "rules" } },
    ],
    unsure: [
      { do: "request-review", target: { to: "teams", teams: ["core"] } },
      { do: "assign", target: { to: "author" } },
      { do: "request-review", target: { to: "users", users: ["alice"] }, when: { ci: ["pending", "none"] } },
      { do: "nothing" },
    ],
  },
  labels: { pass: "Ready", fail: "Triage: Not Ready", unsure: "Look at me" },
};

/** As corbitsdev/corbits-code saved it in the portal. */
const corbitsCode: CheckPack = {
  ...emptyPack("corbitsdev/corbits-code"),
  checks: {
    "max-files-changed": { enabled: true, maxFiles: 25 },
    "max-lines-changed": { enabled: true, maxLines: 2500 },
    focused: { enabled: true },
    docs: { enabled: false },
    "linked-issue": { enabled: true, tracker: "either" },
    "no-merge-conflicts": { enabled: true },
    "ci-green": { enabled: true },
    "no-forbidden-paths": { enabled: true, forbiddenGlobs: ["vendor/**", "node_modules/**"] },
  },
  actions: { when: ["opened", "updated", "checks", "ready"], pass: [], fail: [], unsure: [] },
};

const versionOne = readCheckPack({
  kind: "corbits.triage.check-pack",
  schemaVersion: 1,
  repo: REPO,
  checks: { size: { enabled: true, maxFiles: 10, maxLines: 400 }, issue: { enabled: true } },
  custom: [{ id: "tests-added", name: "Tests added", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "New behaviour has a test." }],
  actions: { when: ["opened"], pass: [{ kind: "approve" }], fail: [{ kind: "labels", target: { from: "list", labels: ["needs work"] } }], unsure: [] },
}, REPO);

const STORED: Array<[string, CheckPack]> = [
  ["an empty policy", emptyPack(REPO)],
  ["the recommended policy", recommendedPack(REPO)],
  ["every step, target and condition", everyStep],
  ["corbitsdev/corbits-code's saved rules", corbitsCode],
  ["a version 1 policy", versionOne],
];

function runs(pack: CheckPack) {
  return VERDICTS.map((verdict) => evaluateActions({ facts, checks: [], verdict, reason: "decided", pack }));
}

describe("a saved policy exported as a policy file", () => {
  test.each(STORED)("%s reads back as the same rules, steps and effect ids", (_name, saved) => {
    const { text, unexpressed } = exportPolicyFile(saved);
    const file = readPolicyFile(text, saved.repo) as CheckPack;
    expect(policyDifferences(saved, file)).toEqual([]);
    expect(file.actions).toEqual(saved.actions);
    expect(file.labels).toEqual(saved.labels);
    expect(runs(file)).toEqual(runs(saved));
    expect(runs(saved).flat().some((action) => "effectId" in action)).toBe(saved.actions.pass.length + saved.actions.fail.length + saved.actions.unsure.length > 0);
    expect(unexpressed).toEqual([]);
  });

  test("what a file cannot hold is listed and left out, never run in its place", () => {
    const saved: CheckPack = {
      ...everyStep,
      checks: { ...everyStep.checks, "max-lines-changed": { enabled: true } },
      custom: [
        ...everyStep.custom,
        { id: "risk", name: "Risk level", group: "pull-request", kind: "model", shape: "score", subject: "the risk", levels: ["high", "low"], failBelow: "low" },
        { id: "per-file", name: "Per file", group: "pull-request", kind: "model", shape: "is-true", claim: "Each file has a header.", scope: "file" },
      ],
    };
    const { text, unexpressed } = exportPolicyFile(saved);
    expect(unexpressed).toEqual([
      "Flag pull requests over any number of lines changed stops after the merge; a policy file can't hold it without a value.",
      "Risk level is called Risk in the file.",
      "Risk level stops after the merge; a policy file can't hold it.",
      "Per file stops after the merge; a policy file can't hold it.",
    ]);
    const file = readPolicyFile(text, REPO) as CheckPack;
    expect(policyDifferences(saved, file)).toHaveLength(3);
    expect(runs(file)).toEqual(runs(saved));
  });
});

describe("a policy file compared with saved rules", () => {
  test("corbitsdev/corbits-code's file drops vendor/** from the forbidden paths, and only that differs", () => {
    const file = readPolicyFile(`# Corbits Triage policy.
checks:
  max-files-changed: { enabled: true, maxFiles: 25 }
  max-lines-changed: { enabled: true, maxLines: 2500 }
  focused: { enabled: true }
  docs: { enabled: false }
  linked-issue: { enabled: true, tracker: either }
  no-merge-conflicts: { enabled: true }
  ci-green: { enabled: true }
  no-forbidden-paths: { enabled: true, forbiddenGlobs: [node_modules/**] }
custom: []
actions: { when: [opened, updated, checks, ready], pass: [], fail: [], unsure: [] }
`, corbitsCode.repo) as CheckPack;
    expect(policyDifferences(corbitsCode, file)).toEqual([
      { rule: "Never accept changes to", saved: ["vendor/**", "node_modules/**"], file: ["node_modules/**"], instead: "Pull requests that change vendor/** will no longer fail." },
    ]);
  });

  test("CI green written down and off lets merges skip CI, so it differs from no CI green row", () => {
    const merging: CheckPack = { ...emptyPack(REPO), actions: { ...emptyPack(REPO).actions, pass: [{ do: "merge" }] } };
    const skipping = { ...merging, checks: { "ci-green": { enabled: false } } };
    expect(policyDifferences(merging, skipping)).toEqual([{ rule: "CI must pass before merge", saved: ["merges wait for CI"], file: ["merges skip CI"], instead: "Merges will no longer wait for CI." }]);
    expect(policyDifferences(skipping, merging)).toEqual([{ rule: "CI must pass before merge", saved: ["merges skip CI"], file: ["merges wait for CI"], instead: "Failing CI will no longer fail pull requests; merges still wait for it." }]);
    expect(policyDifferences(skipping, readPolicyFile(exportPolicyFile(skipping).text, REPO) as CheckPack)).toEqual([]);
  });

  test("wording, reasons, evidence, list order within a rule and author order are not differences; a step's place is", () => {
    const reworded: CheckPack = {
      ...everyStep,
      checks: { ...everyStep.checks, "no-forbidden-paths": { enabled: true, forbiddenGlobs: [".github/**", "vendor/**"] } },
      custom: [...everyStep.custom].reverse(),
      actions: { ...everyStep.actions, pass: [{ do: "approve", when: { author: ["COLLABORATOR", "OWNER", "MEMBER"], ci: ["passing"] } }, ...everyStep.actions.pass.slice(1)] },
    };
    expect(policyDifferences(everyStep, reworded)).toEqual([]);
    const moved = { ...everyStep, actions: { ...everyStep.actions, unsure: [...everyStep.actions.unsure].reverse() } };
    expect(policyDifferences(everyStep, moved).map((difference) => difference.rule)).toEqual(["When Triage is unsure"]);
  });
});
