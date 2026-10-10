import { describe, expect, test } from "bun:test";
import { classificationSources, emptyPack, type CheckPack } from "@corbits/triage-contracts";
import { renderVerdict, toMirrorRequest } from "./render.js";

describe("duplicate rendering", () => {
  test("keeps a detected duplicate open until a human requests close", () => {
    const verdict = renderVerdict({
      author: "octocat",
      det: {
        state: "needs-decision",
        reason: "matches #7",
        findings: [],
        checks: [],
        duplicateOf: 7,
        needsJudgment: false,
      },
    });

    expect(verdict.duplicate).toBe(true);
    expect(verdict.close).toBe(false);
    expect(toMirrorRequest({ repo: "acme/widgets", number: 8, ...verdict })).toMatchObject({
      repo: "acme/widgets",
      number: 8,
      close: false,
    });
  });
});

describe("custom check rendering", () => {
  test("a model row is asked by its stored id; a rule row is not a question", () => {
    const pack: CheckPack = {
      ...emptyPack("acme/widgets"),
      custom: [
        { id: "custom-1", name: "No vendor edits", group: "code-vs-ci", kind: "rule", rule: "paths-unchanged", globs: ["vendor/**"] },
        { id: "custom-2", name: "Ticket", group: "pull-request", kind: "model", shape: "is-true", claim: "The title mentions a ticket id." },
      ],
    };
    const verdict = renderVerdict({
      author: "octocat",
      det: {
        state: "ready-monitoring",
        reason: "all deterministic checks passed",
        findings: [],
        checks: [],
        duplicateOf: null,
        needsJudgment: true,
        sources: classificationSources(pack),
      },
      answers: { "custom-2": 0.1 },
    });

    expect(verdict.checks).toEqual([
      { check: "custom-2", kind: "model", result: "fail", reason: 'does not meet "Ticket"', evidence: [] },
    ]);
  });
});
