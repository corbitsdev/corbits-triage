import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { CHECK_PACK_KIND, policyOverrideSchema, readCheckPack, readPolicyOverride, readSharedPolicy, sharedPolicySchema, VERDICT_LABELS, type CustomCheck, type Step } from "./check-pack.ts";
import { resolvePolicy, storedPolicyPack } from "./resolve-policy.ts";

const REPO = "acme/widgets";
const HEADER = { kind: CHECK_PACK_KIND, schemaVersion: 2 } as const;
const TICKET: CustomCheck = { id: "ticket", name: "Ticket", group: "pull-request", kind: "model", shape: "is-true", claim: "The description links a ticket." };
const SIZE: CustomCheck = { id: "scope", name: "Scope", group: "pull-request", kind: "model", shape: "choose", options: ["small", "large"], failOn: ["large"] };
const TESTS: CustomCheck = { id: "coverage", name: "Coverage", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "Changed code has tests." };
const REVIEW: Step = { do: "request-review", target: { to: "codeowners" } };
const APPROVE: Step = { do: "approve" };
const CLOSE: Step = { do: "close", for: "external" };

const SHARED = {
  ...HEADER,
  checks: { "max-files-changed": { enabled: false, maxFiles: 30 }, "no-forbidden-paths": { enabled: true, forbiddenGlobs: ["vendor/**"] }, "ci-green": { enabled: true } },
  custom: [TICKET, SIZE],
  actions: { when: ["opened", "updated"], pass: [APPROVE], fail: [CLOSE], unsure: [REVIEW] },
  labels: { pass: "Ready to ship" },
};

describe("resolvePolicy", () => {
  test("a repository overrides shared rules by id and shared steps and labels by verdict, and inherits the rest", () => {
    const override = {
      ...HEADER,
      repo: REPO,
      extends: "art_shared",
      checks: { "max-files-changed": { maxFiles: 50 }, "no-forbidden-paths": { forbiddenGlobs: ["dist/**"] }, "ci-green": { enabled: false }, docs: {} },
      custom: [{ ...SIZE, enabled: false }, TESTS],
      actions: { fail: [] },
      labels: { fail: "Needs work" },
    };
    expect(sharedPolicySchema(SHARED)).not.toBeInstanceOf(type.errors);
    expect(policyOverrideSchema(override)).not.toBeInstanceOf(type.errors);
    expect(resolvePolicy(readSharedPolicy(SHARED), readPolicyOverride(JSON.stringify(override), REPO))).toEqual({
      ...HEADER,
      repo: REPO,
      checks: {
        "max-files-changed": { enabled: false, maxFiles: 50 },
        "no-forbidden-paths": { enabled: true, forbiddenGlobs: ["dist/**"] },
        "ci-green": { enabled: false },
        docs: { enabled: true },
      },
      custom: [TICKET, { ...SIZE, enabled: false }, TESTS],
      actions: { when: ["opened", "updated"], pass: [APPROVE], fail: [], unsure: [REVIEW] },
      labels: { pass: "Ready to ship", fail: "Needs work", unsure: VERDICT_LABELS.unsure },
    });
  });

  test("refusals: past the custom rule cap, a shared policy that extends, unknown lists, a pack read alone, a target that is no workspace policy", () => {
    const many = Array.from({ length: 7 }, (_, i): CustomCheck => ({ ...TESTS, id: `coverage-${i + 2}` }));
    const override = readPolicyOverride({ ...HEADER, repo: REPO, extends: "art_shared", custom: many }, REPO);
    expect(() => resolvePolicy(readSharedPolicy(SHARED), override)).toThrow("at most 8 custom rules together");
    expect(() => readSharedPolicy({ ...SHARED, extends: "art_other" })).toThrow("A shared policy must not extend another.");
    expect(() => readPolicyOverride({ ...HEADER, repo: REPO, extends: "art_shared", actions: { always: [] } }, REPO)).toThrow("actions.always must be removed");
    expect(() => readCheckPack({ ...HEADER, repo: REPO, extends: "art_shared" })).toThrow("extends a workspace policy");
    expect(() => storedPolicyPack(REPO, { ...HEADER, repo: REPO, extends: "art_shared" }, { title: "check-pack/acme/other", content: SHARED })).toThrow("not a workspace policy");
  });
});
