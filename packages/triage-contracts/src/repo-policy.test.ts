import { describe, expect, test } from "bun:test";
import { authorAssociation, DEFAULT_REPO_POLICY, repoPolicy, tierOf } from "./repo-policy.ts";

describe("repoPolicy", () => {
  test("defaults missing fields to all-on human-approved policy", () => {
    expect(repoPolicy(undefined)).toEqual(DEFAULT_REPO_POLICY);
    expect(repoPolicy({})).toEqual(DEFAULT_REPO_POLICY);
    expect(repoPolicy({ name: "acme/widgets", connected: true })).toEqual(DEFAULT_REPO_POLICY);
  });

  test("fills partial check flags and nested policy objects", () => {
    expect(repoPolicy({ cleanupMode: "automated", checks: { ci: false } })).toEqual({
      cleanupMode: "automated",
      enabled: false,
      triageDrafts: true,
      checks: {
        draft: true,
        ci: false,
        duplicate: true,
        conflicts: true,
        reviewers: false,
        drift: true,
      },
      roles: {},
      approvedAuthors: [],
    });
    expect(repoPolicy({
      name: "acme/widgets",
      policy: {
        enabled: false,
        triageDrafts: false,
        checks: { draft: false, drift: false },
        roles: {
          " maintainers ": { teams: ["core", " core "], users: [] },
          "": { users: ["ghost"] },
          empty: { users: [" "] },
          broken: { users: "ghost", teams: ["core"] },
        },
      },
    })).toEqual({
      cleanupMode: "human-approved",
      enabled: false,
      triageDrafts: false,
      checks: {
        draft: false,
        ci: true,
        duplicate: true,
        conflicts: true,
        reviewers: false,
        drift: false,
      },
      roles: { maintainers: { teams: ["core"] } },
      approvedAuthors: [],
    });
  });

  test("approved authors are trimmed, lowercased, de-duplicated and survive a round trip", () => {
    const policy = repoPolicy({ approvedAuthors: [" Alice ", "bob", "alice", "", 7] });
    expect(policy.approvedAuthors).toEqual(["alice", "bob"]);
    expect(repoPolicy(policy)).toEqual(policy);
  });
});

describe("tierOf", () => {
  test.each([
    ["OWNER", "alice", [], "internal"],
    ["MEMBER", "alice", [], "internal"],
    ["COLLABORATOR", "alice", [], "approved"],
    ["CONTRIBUTOR", "alice", ["alice"], "approved"],
    ["NONE", "Alice", ["alice"], "approved"],
    ["FIRST_TIME_CONTRIBUTOR", "alice", ["bob"], "external"],
    [authorAssociation("SOMETHING_NEW"), "alice", [], "external"],
  ] as const)("%p %p %p is %p", (association, author, approved, tier) => {
    expect(tierOf(association, author, approved)).toBe(tier);
  });
});
