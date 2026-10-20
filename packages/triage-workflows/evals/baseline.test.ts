import { expect, test } from "bun:test";
import { assertPublic, baselineOf, type BaselineRun } from "./baseline.js";

const KEY = "sk-ant-fake-key";
const ENDPOINT = "https://opencode.ai/zen/v1/systemone";

test("a baseline holds only allowlisted fields", () => {
  const run: unknown = {
    workflow: "pr-triage",
    eval: "judge",
    apiKey: KEY,
    origin: ENDPOINT,
    steps: { "triage-judge": { provider: "opencode-zen", model: "jev-1.13", baseURL: ENDPOINT, apiKey: KEY } },
    usage: { "opencode-zen/jev-1.13": { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: null, headers: { authorization: KEY } } },
    cases: [{ id: "45", failed: false, verdict: "pass", rules: { docs: "pass" }, reply: `called ${ENDPOINT} with ${KEY}` }],
    totals: { verdict: { passed: 1, counted: 1 } },
  };
  const out = baselineOf(run as BaselineRun, { commit: "abc123", dirty: false });
  const text = JSON.stringify(out);
  expect(text).not.toContain(KEY);
  expect(text).not.toContain(ENDPOINT);
  expect(Object.keys(out).sort()).toEqual(["cases", "commit", "costUsd", "date", "dirty", "eval", "pricesAsOf", "steps", "totals", "usage", "workflow"]);
  expect(out.steps).toEqual({ "triage-judge": { provider: "opencode-zen", model: "jev-1.13" } });
  expect(Object.keys(out.usage["opencode-zen/jev-1.13"]!).sort()).toEqual(["cacheRead", "cacheWrite", "costUsd", "input", "output", "price"]);
  expect(out.cases).toEqual([{ id: "45", failed: false, verdict: "pass", rules: { docs: "pass" } }]);
});

test("no baseline is written for a private repository", () => {
  const visibility: Record<string, string> = { "a/public": "public", "a/secret": "private" };
  expect(() => assertPublic(["a/public", "a/secret", "a/secret"], (repo) => visibility[repo]!)).toThrow("a/secret not public");
});
