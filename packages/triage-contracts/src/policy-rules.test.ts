import { describe, expect, test } from "bun:test";
import { askRules, labelRules, POLICY_EVENTS, readCheckPack, type CheckPack } from "./check-pack.ts";
import { exportPolicyFile } from "./policy-export.ts";
import { checkPolicyFile, readPolicyFile } from "./policy-file.ts";
import { extendedFilePack } from "./resolve-policy.ts";

const REPO = "acme/widgets";

const FILE = `
rules:
  - check: max-lines-changed
    text: A pull request changes at most 400 lines.
    max: 400
    reason: Large changes were split before review.
    evidence: ["#44", "acme/api#57"]
  - check: focused
    text: A pull request makes one focused change.
    reason: Mixed changes were closed and split.
    evidence: [maintainer-stated]
  - id: errors-are-handled
    check: model
    text: Every new call that can fail handles or propagates its error.
    reason: Two outages came from swallowed errors.
    evidence: ["https://example.com/postmortem"]
  - id: no-trailers
    check: text
    text: Commits carry no attribution trailers.
    fields: [commits]
    failWhen: contains
    phrases: ["Co-Authored-By:"]
    reason: Maintainer-stated.
    evidence: [maintainer-stated]
    enabled: false
actions:
  pass:
    - do: approve
      when: { author: [OWNER, MEMBER, COLLABORATOR], ci: [passing] }
  fail:
    - do: close
      when: { author: [bots, first-timers], lines: { over: 1000 }, linkedIssue: false }
labels: { pass: Ready }
`;

describe("policy file schema 3", () => {
  test("rules read as built-in rows and custom rules with their reason and evidence, and steps keep their conditions", () => {
    const policy = readPolicyFile(FILE, REPO);
    expect(policy.checks).toEqual({
      "max-lines-changed": { enabled: true, maxLines: 400, text: "A pull request changes at most 400 lines.", reason: "Large changes were split before review.", evidence: ["#44", "acme/api#57"] },
      focused: { enabled: true, text: "A pull request makes one focused change.", reason: "Mixed changes were closed and split.", evidence: ["maintainer-stated"] },
    });
    expect(policy.custom).toEqual([
      { id: "errors-are-handled", name: "Errors are handled", group: "pull-request", kind: "model", shape: "is-true", claim: "Every new call that can fail handles or propagates its error.", reason: "Two outages came from swallowed errors.", evidence: ["https://example.com/postmortem"] },
      { id: "no-trailers", name: "No trailers", group: "pull-request", kind: "text", enabled: false, text: "Commits carry no attribution trailers.", fields: ["commits"], failWhen: "contains", phrases: ["Co-Authored-By:"], reason: "Maintainer-stated.", evidence: ["maintainer-stated"] },
    ]);
    expect(policy.actions).toEqual({
      when: [...POLICY_EVENTS],
      pass: [{ do: "approve", when: { author: ["OWNER", "MEMBER", "COLLABORATOR"], ci: ["passing"] } }],
      fail: [{ do: "close", when: { author: ["BOT", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER"], linkedIssue: false, lines: { over: 1000 } } }],
      unsure: [],
    });
    expect(policy.labels).toMatchObject({ pass: "Ready" });
  });

  test("the old shape still reads, each step in its place, its author as its only condition", () => {
    const policy = readPolicyFile(`
checks:
  ci-green: { enabled: true }
actions:
  when: [opened]
  pass: [{ do: approve, for: maintainers }, { do: merge, for: anyone }]
  fail: [{ do: close, for: { team: acme/core } }]
  unsure: []
`, REPO);
    expect(policy.actions).toEqual({ when: ["opened"], pass: [{ do: "approve", when: { author: ["OWNER", "MEMBER", "COLLABORATOR"] } }, { do: "merge" }], fail: [{ do: "close", when: { author: [{ team: "acme/core" }] } }], unsure: [] });
  });

  test("a schema 3 file that extends a workspace policy holds only what it sets", () => {
    const policy = readPolicyFile(`
extends: shared-1
rules:
  - check: ci-green
    text: CI passes.
    reason: Required by branch protection.
    evidence: [maintainer-stated]
actions:
  on: [opened]
`, REPO);
    expect(policy).toMatchObject({ extends: "shared-1", checks: { "ci-green": { enabled: true, text: "CI passes." } }, custom: [], actions: { when: ["opened"] } });
  });

  test.each([
    ["rules:\n  - check: ci-green\n    text: CI passes.\n    evidence: [maintainer-stated]\n", "reason must be"],
    ["rules:\n  - check: ci-green\n    text: CI passes.\n    reason: Required.\n    evidence: [some PR]\n", "evidence"],
    ["rules:\n  - id: ci\n    check: ci-green\n    text: CI passes.\n    reason: Required.\n    evidence: [maintainer-stated]\n", "id must be removed"],
    ["rules:\n  - check: model\n    text: It is tidy.\n    reason: Required.\n    evidence: [maintainer-stated]\n", "id must be"],
    ["rules: []\nchecks: {}\n", "`checks` is not a key"],
    ["rules: []\nactions:\n  pass: [{ do: approve, for: maintainers }]\n", "pass step 1 must say who it is for in when.author"],
    ["rules: []\nactions:\n  pass: [{ do: approve, when: { lines: { over: 10, atMost: 5 } } }]\n", "atMost must be more than over"],
    ["rules: []\nactions:\n  pass: [{ do: approve, when: {} }]\n", "must set a condition"],
  ])("refuses %#", (text, reason) => {
    expect(() => readPolicyFile(text, REPO)).toThrow(reason);
  });

  test("a refused file says on which line each problem is", () => {
    const missingReason = "rules:\n  - check: ci-green\n    text: CI passes.\n    reason: Required.\n    evidence: [maintainer-stated]\n  - check: focused\n    text: One change.\n    evidence: [maintainer-stated]\n";
    expect(checkPolicyFile(missingReason, REPO)).toEqual({ ok: false, problems: [{ message: expect.stringContaining("reason must be"), line: 6 }] });
    expect(checkPolicyFile("# policy\nrules: [\n", REPO)).toEqual({ ok: false, problems: [{ message: expect.stringContaining("is not YAML"), line: 3, column: 1 }] });
  });

  test("onFail labels by its check unless a label is named, takes the file's default, survives export, is the extending file's for a rule it lists, a label needs onFail: label, and advisory is refused", () => {
    const rule = "  - check: docs\n    text: Docs follow the change.\n    reason: Docs ship with code.\n    evidence: [maintainer-stated]\n";
    const files = "  - check: max-files-changed\n    text: At most 30 files.\n    max: 30\n    reason: Size is hygiene.\n    evidence: [maintainer-stated]\n";
    const labelled = readPolicyFile(`rules:\n${rule}    onFail: label\n${files}    onFail: label\n    label: big\n`, REPO) as CheckPack;
    expect([...labelRules(labelled)]).toEqual([["max-files-changed", "big"], ["docs", "docs: check"]]);
    expect(readPolicyFile(exportPolicyFile(labelled, false).text, REPO)).toEqual(labelled);
    const ask = readPolicyFile(`onFail: ask\nrules:\n${rule}${files}    onFail: fail\n`, REPO) as CheckPack;
    expect(askRules(ask)).toEqual(["docs"]);
    expect(readPolicyFile(exportPolicyFile(ask, false).text, REPO)).toEqual(ask);
    const shared = { repo: "acme/shared", policy: readPolicyFile(`rules:\n${rule}    onFail: ask\n${files}    onFail: label\n`, "acme/shared") };
    const extending = extendedFilePack(REPO, readPolicyFile(`extends: acme/shared\nrules:\n${rule}    onFail: fail\n${files}`, REPO), shared);
    expect([askRules(extending), [...labelRules(extending)]]).toEqual([[], []]);
    expect(askRules(extendedFilePack(REPO, readPolicyFile(`extends: acme/shared\nonFail: ask\nrules:\n${files}`, REPO), shared))).toEqual(["max-files-changed", "docs"]);
    expect(() => readCheckPack({ ...ask, checks: { docs: { enabled: true, advisory: true } } }, REPO)).toThrow("write onFail: label instead");
    expect(checkPolicyFile(`rules:\n${rule}    advisory: true\n`, REPO)).toMatchObject({ ok: false });
    expect(checkPolicyFile(`rules:\n${rule}    label: docs\n`, REPO)).toEqual({ ok: false, problems: [{ message: "Rule docs label needs onFail: label.", line: 2 }] });
    expect(checkPolicyFile(`rules:\n${rule}    onFail: label\n    label: "rule: docs"\n`, REPO)).toEqual({ ok: false, problems: [{ message: "Rule docs label rule: docs is one Triage takes back; name another." }] });
  });
});
