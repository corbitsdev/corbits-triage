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
  const { checks, verdict } = await runChecks({ repo: PR.repo, number: PR.number }, readOnly(writes), pack);
  const byId = Object.fromEntries(checks.map((check) => [check.check, check]));
  expect(byId["max-files-changed"]).toMatchObject({ kind: "machine", result: "fail", evidence: ["2 files (max 1)"] });
  expect(byId["focused"]).toBeUndefined();
  expect(verdict?.verdict).toBe("fail");
  expect(writes).toEqual([]);
});

test("model checks are left out, so passing rules reach a verdict from the rules alone", async () => {
  const writes: string[] = [];
  const pack = { ...emptyPack(PR.repo), checks: { "max-files-changed": { enabled: true, maxFiles: 30 }, docs: { enabled: true } } };
  const { checks, verdict } = await runChecks({ repo: PR.repo, number: PR.number }, readOnly(writes), pack);
  expect(checks.filter((check) => check.kind === "machine").every((check) => check.result === "pass")).toBe(true);
  expect(checks.find((check) => check.check === "docs")).toBeUndefined();
  expect(verdict?.verdict).toBe("pass");
  expect(writes).toEqual([]);
});
