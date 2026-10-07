import { describe, expect, test } from "bun:test";
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
