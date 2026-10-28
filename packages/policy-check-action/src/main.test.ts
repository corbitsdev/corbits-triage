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
  const run = Bun.spawnSync([process.execPath, "--conditions=intx-src", MAIN, root, "acme/widgets"], { env: {} });
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
  expect(check(`${rules}code-review:\n  on: true\n  when: { triage: maybe }\n`).stdout).toBe("::error file=.corbits-triage.yml,line=8::`code-review.when.triage` must be pass, fail or unsure, or a list of them.\n");
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

/** Runs the Action on `pr`'s pull request event against GitHub served from it and `reviews`, with `policy`, if any, on the base branch. */
async function onPullRequest(pr: typeof PR, policy: string | undefined, reviews: unknown[] = []) {
  const served = fixtureGithub(pr, {});
  const github = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === `/repos/${pr.repo}/pulls/${pr.number}/reviews`) return Response.json(reviews);
      if (url.pathname !== `/repos/${pr.repo}/contents/.corbits-triage.yml`) return served(url);
      if (policy === undefined || url.searchParams.get("ref") !== "base") return new Response(null, { status: 404 });
      return new Response(policy);
    },
  });
  const root = mkdtempSync(join(tmpdir(), "policy-check-"));
  writeFileSync(join(root, "event.json"), JSON.stringify({ pull_request: { number: pr.number, head: { sha: HEAD }, base: { sha: "base" } } }));
  writeFileSync(join(root, "summary.md"), "");
  const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: join(root, "event.json"), GITHUB_API_URL: `http://localhost:${github.port}`, GITHUB_TOKEN: "token", GITHUB_STEP_SUMMARY: join(root, "summary.md") };
  try {
    const run = Bun.spawn([process.execPath, "--conditions=intx-src", MAIN, root, pr.repo], { env, stdout: "pipe" });
    const stdout = await new Response(run.stdout).text();
    return { exitCode: await run.exited, stdout, summary: readFileSync(join(root, "summary.md"), "utf8") };
  } finally {
    github.stop(true);
  }
}

test("on a pull request the base policy's rules run without a model, each failure is marked, and a failed rule fails the job", async () => {
  const { exitCode, stdout, summary } = await onPullRequest(PR, BASE_POLICY);
  expect(exitCode).toBe(1);
  expect(stdout).toContain("::error title=no-forbidden-paths::");
  expect(stdout).toContain("::warning title=max-lines-changed::");
  expect(stdout).not.toContain("title=linked-issue");
  expect(stdout).not.toContain("| Rule |");
  expect(summary).toContain("| linked-issue | pass |");
  expect(summary).toContain("| focused | skipped | answered by a model |");
}, 30_000);

test("text from the pull request never starts a workflow command of its own", async () => {
  const forged = "\n::error::forged";
  const policy = "rules:\n  - { id: forged, check: text, text: No forgery., fields: [title, description], failWhen: contains, phrases: [forged], reason: Safe., evidence: [maintainer-stated] }\n";
  const { stdout } = await onPullRequest({ ...PR, title: `Bump${forged}`, body: `Fixes #3${forged}` }, policy);
  const commands = stdout.split("\n").filter((line) => line.startsWith("::"));
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.every((line) => /^::(error|warning) title=[\w-]+::/.test(line))).toBe(true);
}, 30_000);

test("an unreadable base policy fails the job, and one that extends another or none passes it", async () => {
  const unreadable = await onPullRequest(PR, "rules: [\n");
  expect(unreadable.exitCode).toBe(2);
  expect(unreadable.stdout).toContain("::error title=base-policy::.corbits-triage.yml on the base branch cannot be read, so no rules ran:");
  const extending = await onPullRequest(PR, "extends: acme/shared\n");
  expect(extending.exitCode).toBe(0);
  expect(extending.stdout).toContain("::notice title=base-policy::.corbits-triage.yml on the base branch extends another policy");
  const none = await onPullRequest(PR, undefined);
  expect(none.exitCode).toBe(0);
  expect(none.stdout).toContain("The base branch has no policy, so no rules ran.");
}, 30_000);

test("triage's own request for changes is not a reviewer's", async () => {
  const policy = "rules:\n  - { check: linked-issue, text: Link an issue., tracker: github, reason: Tracked., evidence: [maintainer-stated] }\n";
  const own = { user: { login: "corbits-triage[bot]", type: "Bot" }, state: "CHANGES_REQUESTED", body: "Fix the rules.\n<!-- corbits-request-changes -->", commit_id: HEAD };
  const { exitCode, stdout } = await onPullRequest(PR, policy, [own]);
  expect(stdout).not.toContain("title=no-changes-requested");
  expect(exitCode).toBe(0);
}, 30_000);

test("a person's marked request for changes still counts", async () => {
  const policy = "rules:\n  - { check: linked-issue, text: Link an issue., tracker: github, reason: Tracked., evidence: [maintainer-stated] }\n";
  const person = { user: { login: "mallory", type: "User" }, state: "CHANGES_REQUESTED", body: "Fix the rules.\n<!-- corbits-request-changes -->", commit_id: HEAD };
  const { stdout } = await onPullRequest(PR, policy, [person]);
  expect(stdout).toContain("title=no-changes-requested");
}, 30_000);
