import { describe, expect, test } from "bun:test";
import { DEFAULT_TIMINGS, timingsFrom } from "@corbits/triage-contracts";
import { loadHubEnv, sandboxSource } from "./env.js";

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

describe("Triage timings", () => {
  const required = {
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/hub",
    BETTER_AUTH_SECRET: "a".repeat(64),
    CREDENTIAL_ENCRYPTION_KEY: "b".repeat(64),
    PRINCIPAL_KEY_ENCRYPTION_KEY: "c".repeat(64),
    SIDECAR_CREDENTIAL_ENCRYPTION_KEY: "d".repeat(64),
    BETTER_AUTH_BASE_URL: "https://hub.example.com",
    PORT: "3000",
    HUB_DATA_DIR: "/data",
  };

  test("a blank timing keeps its default, and one that is not a whole number fails the hub's environment", () => {
    expect(timingsFrom(loadHubEnv({ ...required, TRIAGE_RECONCILE_INTERVAL_MS: "" })).reconcileIntervalMs).toBe(DEFAULT_TIMINGS.reconcileIntervalMs);
    expect(() => loadHubEnv({ ...required, TRIAGE_RECONCILE_INTERVAL_MS: " 300000" })).toThrow("TRIAGE_RECONCILE_INTERVAL_MS");
    expect(() => loadHubEnv({ ...required, TRIAGE_RECONCILE_INTERVAL_MS: "abc" })).toThrow("TRIAGE_RECONCILE_INTERVAL_MS");
  });
});
