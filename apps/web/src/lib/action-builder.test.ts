import { describe, expect, test } from "bun:test";
import type { CustomCheck, Step } from "@corbits/triage-contracts";
import { buildDo, checkFormOf, customCheckOf, doFormOf, type CheckForm, type DoForm } from "./action-builder.ts";

const comment: DoForm = { kind: "comment", body: "Thanks!", labels: ["stale"] };
const commented: Step = { do: "comment", target: { body: "Thanks!" } };

const targets: Array<[DoForm, Step]> = [
  [{ kind: "labels", from: "list", labels: ["bug"], to: "users" }, { do: "labels", target: { from: "list", labels: ["bug"] } }],
  [comment, commented],
  [{ kind: "assign", to: "users", users: ["ada"], teams: ["core"] }, { do: "assign", target: { to: "users", users: ["ada"] } }],
  [{ kind: "assign", to: "teams", teams: ["core"], users: ["ada"] }, { do: "assign", target: { to: "teams", teams: ["core"] } }],
  [{ kind: "assign", to: "author", users: ["ada"] }, { do: "assign", target: { to: "author" } }],
  [{ kind: "request-review", to: "codeowners", teams: ["core"], for: "first-timers" }, { do: "request-review", target: { to: "codeowners" }, for: "first-timers" }],
  [{ kind: "close", body: "unused" }, { do: "close" }],
  [{ kind: "merge", for: { team: "acme/core" } }, { do: "merge", for: { team: "acme/core" } }],
];

describe("buildDo", () => {
  test("every step target keeps exactly the contract keys, and a stored step edits back to itself", () => {
    for (const [step, expected] of targets) {
      expect(buildDo(step)).toEqual(expected);
      expect(buildDo(doFormOf(expected))).toEqual(expected);
    }
  });
});

const checkForms: Array<[CheckForm, CustomCheck]> = [
  [{ name: "Changelog", group: "pull-request", kind: "model", shape: "is-true", claim: "The changelog is updated", subject: "unused" }, { id: "changelog", name: "Changelog", group: "pull-request", kind: "model", shape: "is-true", claim: "The changelog is updated" }],
  [{ name: "Reversible", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "The migration can be rolled back", scope: "hunk", when: ["migrations/**"] }, { id: "reversible", name: "Reversible", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "The migration can be rolled back", scope: "hunk", when: ["migrations/**"] }],
  [{ name: "Clarity", group: "pull-request", kind: "model", shape: "score", subject: "Description clarity", levels: ["poor", "good"], failBelow: "good" }, { id: "clarity", name: "Clarity", group: "pull-request", kind: "model", shape: "score", subject: "Description clarity", levels: ["poor", "good"], failBelow: "good" }],
  [{ name: "Risk", group: "around", kind: "model", shape: "choose", options: ["low", "high"], failOn: ["high"] }, { id: "risk", name: "Risk", group: "around", kind: "model", shape: "choose", options: ["low", "high"], failOn: ["high"] }],
];

describe("customCheckOf", () => {
  test("every shape keeps only its parameters, and a stored check edits back to itself", () => {
    for (const [form, expected] of checkForms) {
      expect(JSON.parse(JSON.stringify(customCheckOf(form, expected.id)))).toEqual(expected);
      expect(JSON.parse(JSON.stringify(customCheckOf(checkFormOf(expected), expected.id)))).toEqual(expected);
    }
  });
});
