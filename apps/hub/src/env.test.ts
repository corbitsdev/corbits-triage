import { describe, expect, test } from "bun:test";
import { sandboxSource } from "./env.js";

const commit = "95c8d142e9e5d96b3f92d4d43d087a564486124f";

describe("sandboxSource", () => {
  test("reads the deploy-set variables", () => {
    expect(sandboxSource({ SANDBOX_REPOSITORY: "corbitsdev/corbits-triage", SANDBOX_COMMIT_SHA: commit })).toEqual({ repository: "https://github.com/corbitsdev/corbits-triage", commit });
  });

  test("falls back to the variables Railway sets on a service deployed from GitHub", () => {
    expect(sandboxSource({ RAILWAY_GIT_REPO_OWNER: "corbitsdev", RAILWAY_GIT_REPO_NAME: "corbits-triage", RAILWAY_GIT_COMMIT_SHA: commit })).toEqual({ repository: "https://github.com/corbitsdev/corbits-triage", commit });
  });

  test("prefers the commit Railway deployed over a hand-set one", () => {
    const stale = "0000000000000000000000000000000000000000";
    expect(sandboxSource({ SANDBOX_REPOSITORY: "corbitsdev/corbits-triage", SANDBOX_COMMIT_SHA: stale, RAILWAY_GIT_COMMIT_SHA: commit }).commit).toBe(commit);
  });

  test("names the variables to set when the commit is missing", () => {
    expect(() => sandboxSource({ SANDBOX_REPOSITORY: "corbitsdev/corbits-triage" })).toThrow("SANDBOX_COMMIT_SHA");
  });
});
