import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyPack } from "@corbits/triage-contracts";
import type { Snapshot } from "@corbits/triage-workflows/evals/cases";
import { fixtureGithub } from "@corbits/triage-workflows/evals/serve";
import { runChecks } from "./run-checks.ts";

const PR = JSON.parse(readFileSync(join(import.meta.dir, "../../../packages/pr-workflow-anthropic/fixtures/godotenv-262.json"), "utf8")) as Snapshot;

function readOnly(writes: string[]) {
  const served = fixtureGithub(PR, {});
  return async function gh(path: string, init?: RequestInit) {
    if ((init?.method ?? "GET") !== "GET") {
      writes.push(path);
      throw new Error("read-only");
    }
    return served(new URL(`https://api.github.com${path}`));
  };
}

test("the definition settles the checks without the model and writes nothing", async () => {
  const writes: string[] = [];
  const pack = { ...emptyPack(PR.repo), checks: { "max-files-changed": { enabled: true, maxFiles: 1 }, focused: { enabled: true } } };
  const { rules } = await runChecks({ repo: PR.repo, number: PR.number }, readOnly(writes), pack);
  const byId = Object.fromEntries(rules.map((rule) => [rule.check, rule]));
  expect(byId["max-files-changed"]).toMatchObject({ kind: "machine", state: "fail", evidence: ["2 files (max 1)"] });
  expect(byId["focused"]).toMatchObject({ kind: "model", state: "not-run" });
  expect(writes).toEqual([]);
});

test("a policy whose checks all pass still reaches the judge's branch and fails closed there", async () => {
  const writes: string[] = [];
  const pack = { ...emptyPack(PR.repo), checks: { "max-files-changed": { enabled: true, maxFiles: 30 }, docs: { enabled: true } } };
  const { rules } = await runChecks({ repo: PR.repo, number: PR.number }, readOnly(writes), pack);
  expect(rules.filter((rule) => rule.kind === "machine").every((rule) => rule.state === "pass")).toBe(true);
  expect(rules.find((rule) => rule.check === "docs")?.state).toBe("not-run");
  expect(writes).toEqual([]);
});
