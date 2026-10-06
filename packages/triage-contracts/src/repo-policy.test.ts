import { describe, expect, test } from "bun:test";
import { DEFAULT_REPO_POLICY, repoPolicy } from "./repo-policy.ts";

describe("repoPolicy", () => {
  test("defaults missing fields to all-on human-approved policy", () => {
    expect(repoPolicy(undefined)).toEqual(DEFAULT_REPO_POLICY);
    expect(repoPolicy({})).toEqual(DEFAULT_REPO_POLICY);
    expect(repoPolicy({ name: "acme/widgets", connected: true })).toEqual(DEFAULT_REPO_POLICY);
  });

  test("fills partial check flags and nested policy objects", () => {
    expect(repoPolicy({ cleanupMode: "automated", checks: { ci: false } })).toEqual({
      cleanupMode: "automated",
      classificationAuthorized: true,
      checks: {
        draft: true,
        ci: false,
        duplicate: true,
        conflicts: true,
        reviewers: true,
        drift: true,
      },
    });
    expect(repoPolicy({
      name: "acme/widgets",
      policy: { classificationAuthorized: false, checks: { draft: false, drift: false } },
    })).toEqual({
      cleanupMode: "human-approved",
      classificationAuthorized: false,
      checks: {
        draft: false,
        ci: true,
        duplicate: true,
        conflicts: true,
        reviewers: true,
        drift: false,
      },
    });
  });
});
