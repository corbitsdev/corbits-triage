import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyPack } from "@corbits/triage-contracts";
import type { Snapshot } from "@corbits/triage-workflows/evals/cases";
import { fixtureGithub } from "@corbits/triage-workflows/evals/serve";
import { pullOf } from "./check-pr.ts";
import { githubApi } from "./github-api.ts";
import { runChecks } from "./run-checks.ts";

const PR = JSON.parse(readFileSync(join(import.meta.dir, "../../../packages/pr-workflow-anthropic/fixtures/godotenv-262.json"), "utf8")) as Snapshot;
const REF = { repo: PR.repo, number: PR.number };
const realFetch = globalThis.fetch;

afterEach(function restoreFetch() {
  globalThis.fetch = realFetch;
});

function serve(answer: (url: URL) => Promise<Response>, authorizations: Array<string | null>) {
  globalThis.fetch = async function fakeFetch(input: string | URL | Request, init?: RequestInit) {
    authorizations.push(new Headers(init?.headers).get("authorization"));
    return answer(new URL(input instanceof Request ? input.url : input));
  } as typeof fetch;
}

test("without a token a public pull request is checked with no authorization header", async () => {
  const authorizations: Array<string | null> = [];
  serve(fixtureGithub(PR, {}), authorizations);
  const api = githubApi(null, "default");
  await pullOf(api, REF);
  const pack = { ...emptyPack(PR.repo), checks: { "max-files-changed": { enabled: true, maxFiles: 1 } } };
  const { rules } = await runChecks(REF, api.gh, pack);
  expect(rules.find((rule) => rule.check === "max-files-changed")?.state).toBe("fail");
  expect(authorizations.length).toBeGreaterThan(1);
  expect(authorizations.every((header) => header === null)).toBe(true);
});

test("without a token a pull request GitHub does not find is reported as possibly private", async () => {
  serve(async () => new Response(null, { status: 404 }), []);
  await expect(pullOf(githubApi(null, "default"), REF)).rejects.toThrow("This repository is private or the pull request was not found.");
});
