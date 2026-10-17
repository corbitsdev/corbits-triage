import { describe, expect, test } from "bun:test";
import { POLICY_EVENTS } from "./check-pack.ts";
import { readPolicyFile } from "./policy-file.ts";

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
    ["rules: []\nchecks: {}\n", "checks must be removed"],
    ["rules: []\nactions:\n  pass: [{ do: approve, for: maintainers }]\n", "pass step 1 must say who it is for in when.author"],
    ["rules: []\nactions:\n  pass: [{ do: approve, when: { lines: { over: 10, atMost: 5 } } }]\n", "atMost must be more than over"],
    ["rules: []\nactions:\n  pass: [{ do: approve, when: {} }]\n", "must set a condition"],
  ])("refuses %#", (text, reason) => {
    expect(() => readPolicyFile(text, REPO)).toThrow(reason);
  });
});
