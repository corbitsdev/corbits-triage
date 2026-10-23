import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CATALOG_IDS, catalogCheckEnabled, checkPolicyFile, parseCheckPack, QUALITY_CHECK_IDS } from "@corbits/triage-contracts";
import { deriveState, type PrFacts } from "@corbits/triage-workflows/logic/checks";
import { NO_FACTS } from "@corbits/triage-workflows/logic/item";
import { fixtureGithub } from "@corbits/triage-workflows/evals/serve";
import { runChecks } from "./checks.js";
import { hostOnly, readChange, type ChangedFile } from "./local-git.js";

const CLI = join(import.meta.dir, "cli.ts");
const RULES = `rules:
  - { check: no-forbidden-paths, text: Never touch vendor/**., paths: ["vendor/**"], reason: Vendored., evidence: [maintainer-stated] }
  - { check: max-lines-changed, text: Flag over 1 line., max: 1, onFail: label, reason: Small., evidence: [maintainer-stated] }
  - { check: conventional-commits, text: Conventional commits., fields: [commits], reason: Readable., evidence: [maintainer-stated] }
  - { check: ci-green, text: CI passes., reason: Required., evidence: [maintainer-stated] }
  - { check: focused, text: One change., reason: Reviewable., evidence: [maintainer-stated] }
`;

function git(root: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

function write(root: string, path: string, text: string | Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A clone of acme/widgets whose main carries `policy` and `files`, on a branch with one commit, `message`, writing `changed` and deleting its null paths. */
function repository(policy: string, files: Record<string, string>, message: string, changed: Record<string, string | Uint8Array | null>): string {
  const root = mkdtempSync(join(tmpdir(), "local-check-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", "git@github.com:acme/widgets.git");
  write(root, ".corbits-triage.yml", policy);
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "chore: start");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(root, "checkout", "-qb", "change");
  for (const [path, text] of Object.entries(changed)) {
    if (text === null) rmSync(join(root, path));
    else write(root, path, text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return root;
}

async function check(root: string) {
  const run = Bun.spawn([process.execPath, "--conditions=intx-src", CLI, "check"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(run.stdout).text(), await new Response(run.stderr).text()];
  return { exitCode: await run.exited, stdout, stderr };
}

test("a commit touching a forbidden path fails", async () => {
  const { exitCode, stdout } = await check(repository(RULES, { "vendor/parser.ts": "a\n" }, "chore: bump", { "vendor/parser.ts": "b\n" }));
  expect(exitCode).toBe(1);
  expect(stdout).toContain("error no-forbidden-paths: pull request touches a forbidden path\nvendor/parser.ts");
  expect(stdout).toContain("| ci-green | skipped | needs the pull request on its host |");
  expect(stdout).toContain("| focused | skipped | answered by a model |");
  expect(stdout).toContain("# Working tree\n\nNo uncommitted changes.");
}, 30_000);

test("a failure only in the uncommitted changes warns, and the exit follows the commits", async () => {
  const root = repository(RULES, { "vendor/parser.ts": "a\n" }, "chore: start work", {});
  write(root, "vendor/parser.ts", "b\n");
  write(root, "vendor/new.ts", "c\n");
  const { exitCode, stdout } = await check(root);
  expect(exitCode).toBe(0);
  const [committed, working] = stdout.split("# Working tree");
  expect(committed).not.toContain("no-forbidden-paths:");
  expect(working).toContain("error no-forbidden-paths: pull request touches a forbidden path\nvendor/parser.ts\nvendor/new.ts");
  expect(working).toContain("warning: the working tree fails where the commits pass");
}, 30_000);

test("a failed rule set to label only warns", async () => {
  const { exitCode, stdout } = await check(repository(RULES, {}, "feat: two lines", { "src/a.ts": "a\nb\n" }));
  expect(exitCode).toBe(0);
  expect(stdout).toContain("warning max-lines-changed:");
}, 30_000);

test("a policy that cannot be read is a run error", async () => {
  const { exitCode, stderr } = await check(repository("rules: [\n", {}, "feat: x", { "a.ts": "a\n" }));
  expect(exitCode).toBe(2);
  expect(stderr).toContain(".corbits-triage.yml on origin/main cannot be read");
}, 30_000);

const PARITY = RULES.replace('paths: ["vendor/**"]', 'paths: ["vendor/**", "docs/*.md"]');

test("rules give the same results locally as on the hosted pull request, whatever the file names and kinds", async () => {
  const files = [
    { filename: "bin.dat", status: "added", additions: 0, deletions: 0 },
    { filename: 'docs/"q"\t.md', status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+q" },
    { filename: "docs/my notes.md", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+n" },
    { filename: "gone.txt", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-x" },
    { filename: "vendor/parser.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
  ];
  const pr = { repo: "acme/widgets", number: 7, title: "", body: "", bodyHtml: "", author: "octocat", commits: ["bump parser"], docs: {}, files };
  const checked = checkPolicyFile(PARITY, pr.repo);
  if (!checked.ok) throw new Error("the policy is invalid");
  const hosted = await runChecks(checked.policy, { repo: pr.repo, number: pr.number, headSha: "e0a1e0a1e0a1e0a1e0a1e0a1e0a1e0a1e0a1e0a1" }, fixtureGithub(pr, {}), hostOnly);
  const root = repository(PARITY, { "vendor/parser.ts": "a\n", "gone.txt": "x\n" }, "bump parser", {
    "vendor/parser.ts": "b\n",
    "gone.txt": null,
    "bin.dat": new Uint8Array([0, 1, 2, 0]),
    "docs/my notes.md": "n\n",
    'docs/"q"\t.md': "q\n",
  });
  expect(readChange(root, "origin/main", false).files).toEqual(files as ChangedFile[]);
  const local = await check(root);
  expect(hosted.failures.find((failure) => failure.title === "no-forbidden-paths")?.text).toContain("docs/my notes.md");
  expect(hosted.summary.some((row) => row.startsWith("| conventional-commits | fail |"))).toBe(true);
  expect(local.stdout).toStartWith(`# Committed\n\n${hosted.summary.join("\n")}\n`);
  expect(local.exitCode).toBe(hosted.failed ? 1 : 0);
}, 60_000);

const EVIDENCE = "reason: R., evidence: [maintainer-stated]";
const EVERY_MACHINE_RULE = `rules:
  - { check: max-files-changed, text: T., max: 10, ${EVIDENCE} }
  - { check: max-lines-changed, text: T., max: 10, ${EVIDENCE} }
  - { check: max-lines-changed-per-file, text: T., max: 10, ${EVIDENCE} }
  - { check: max-additions, text: T., max: 10, ${EVIDENCE} }
  - { check: max-deletions, text: T., max: 10, ${EVIDENCE} }
  - { check: linked-issue, text: T., tracker: github, ${EVIDENCE} }
  - { check: no-merge-conflicts, text: T., ${EVIDENCE} }
  - { check: ci-green, text: T., ${EVIDENCE} }
  - { check: no-forbidden-paths, text: T., paths: ["vendor/**"], ${EVIDENCE} }
  - { check: conventional-commits, text: T., ${EVIDENCE} }
  - { check: hidden-content, text: T., ${EVIDENCE} }
  - { check: regression-risk, text: T., ${EVIDENCE} }
`;

test("every rule whose result turns on the title or description is skipped locally", () => {
  const checked = checkPolicyFile(EVERY_MACHINE_RULE, "acme/widgets");
  if (!checked.ok) throw new Error("the policy is invalid");
  const pack = parseCheckPack(checked.policy, "acme/widgets")!;
  expect(CATALOG_IDS.filter((id) => !(QUALITY_CHECK_IDS as readonly string[]).includes(id) && !catalogCheckEnabled(pack, id))).toEqual([]);
  const described: PrFacts = { ...NO_FACTS, repo: "acme/widgets", number: 1, title: "feat: add", body: "Fixes https://github.com/acme/widgets/issues/1", commitMessages: ["feat: add"], state: "open", mergeable: true };
  const bare: PrFacts = { ...described, title: "add", body: "", hidden: ["title: a comment"] };
  const results = [described, bare].map((facts) => new Map(deriveState(facts, undefined, pack).checks.map((check) => [check.check, `${check.result}: ${check.reason}`])));
  const turned = [...results[0]!.keys()].filter((id) => results[0]!.get(id) !== results[1]!.get(id));
  const skipped = new Set(hostOnly(pack).map(({ id }) => id));
  expect(turned.length).toBeGreaterThan(0);
  expect(turned.filter((id) => !skipped.has(id))).toEqual([]);
});
