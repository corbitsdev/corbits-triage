import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGithub } from "@corbits/triage-workflows/evals/serve";

const MAIN = join(import.meta.dir, "main.ts");

function check(file: string | null): { exitCode: number; stdout: string } {
  const root = mkdtempSync(join(tmpdir(), "policy-check-"));
  if (file === null) mkdirSync(join(root, ".corbits-triage.yml"));
  else writeFileSync(join(root, ".corbits-triage.yml"), file);
  const run = Bun.spawnSync([process.execPath, "--conditions=intx-src", MAIN, root, "acme/widgets"]);
  return { exitCode: run.exitCode, stdout: run.stdout.toString() };
}

test("a valid policy file passes", () => {
  expect(check("rules:\n  - check: ci-green\n    text: CI passes.\n    reason: Required.\n    evidence: [maintainer-stated]\n")).toEqual({ exitCode: 0, stdout: ".corbits-triage.yml is valid.\n" });
});

test("an invalid policy file fails with an annotation on each offending line, or on the file", () => {
  const refused = check("rules:\n  - check: focused\n    text: One change.\n    reason: Required.\n    evidence: [maintainer-stated]\n  - check: ci-green\n    text: CI passes.\n    evidence: [maintainer-stated]\n");
  expect(refused.exitCode).toBe(1);
  expect(refused.stdout).toMatch(/^::error file=\.corbits-triage\.yml,line=6::.*reason must be/);
  expect(check("rules: [\n").stdout).toMatch(/^::error file=\.corbits-triage\.yml,line=2,col=1::The policy file is not YAML/);
  expect(check(null)).toEqual({ exitCode: 1, stdout: "::error file=.corbits-triage.yml::.corbits-triage.yml is not a file.\n" });
}, 15_000);

test("a v4 file passes, and a mistake in a block is marked on its line", () => {
  const rules = "rules:\n  - check: ci-green\n    text: CI passes.\n    reason: Required.\n    evidence: [maintainer-stated]\n";
  expect(check(`${rules}code-review: { on: true, provider: anthropic }\ndecide:\n  - { if: { all: clean }, do: approve }\n`)).toEqual({ exitCode: 0, stdout: ".corbits-triage.yml is valid.\n" });
  expect(check(`${rules}security:\n  on: true\n  when: { triage: maybe }\n`).stdout).toBe("::error file=.corbits-triage.yml,line=8::`security.when.triage` must be pass, fail or unsure, or a list of them.\n");
}, 15_000);

// The head fixtureGithub serves.
const HEAD = "e0a1e0a1e0a1e0a1e0a1e0a1e0a1e0a1e0a1e0a1";
const PR = { repo: "acme/widgets", number: 7, title: "Bump the vendored parser", body: "Fixes #3", bodyHtml: "<p>Fixes #3</p>", author: "octocat", commits: ["chore: bump parser"], docs: {}, files: [{ filename: "vendor/parser.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }] };
const BASE_POLICY = `rules:
  - { check: no-forbidden-paths, text: Never touch vendor/**., paths: ["vendor/**"], reason: Vendored., evidence: [maintainer-stated] }
  - { check: max-lines-changed, text: Flag over 1 line., max: 1, onFail: ask, reason: Small., evidence: [maintainer-stated] }
  - { check: linked-issue, text: Link an issue., tracker: github, reason: Tracked., evidence: [maintainer-stated] }
  - { check: focused, text: One change., reason: Reviewable., evidence: [maintainer-stated] }
`;

test("on a pull request the base policy's rules run without a model, each failure is marked, and a failed rule fails the job", async () => {
  const served = fixtureGithub(PR, {});
  const github = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== `/repos/${PR.repo}/contents/.corbits-triage.yml`) return served(url);
      return url.searchParams.get("ref") === "base" ? new Response(BASE_POLICY) : new Response(null, { status: 404 });
    },
  });
  const root = mkdtempSync(join(tmpdir(), "policy-check-"));
  writeFileSync(join(root, "event.json"), JSON.stringify({ pull_request: { number: PR.number, head: { sha: HEAD }, base: { sha: "base" } } }));
  writeFileSync(join(root, "summary.md"), "");
  const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: join(root, "event.json"), GITHUB_API_URL: `http://localhost:${github.port}`, GITHUB_TOKEN: "token", GITHUB_STEP_SUMMARY: join(root, "summary.md") };
  try {
    const run = Bun.spawn([process.execPath, "--conditions=intx-src", MAIN, root, PR.repo], { env, stdout: "pipe" });
    const stdout = await new Response(run.stdout).text();
    expect(await run.exited).toBe(1);
    expect(stdout).toContain("::error title=no-forbidden-paths::");
    expect(stdout).toContain("::warning title=max-lines-changed::");
    expect(stdout).not.toContain("title=linked-issue");
    const summary = readFileSync(join(root, "summary.md"), "utf8");
    expect(summary).toContain("| linked-issue | pass |");
    expect(summary).toContain("| focused | skipped | answered by a model |");
  } finally {
    github.stop(true);
  }
}, 30_000);
