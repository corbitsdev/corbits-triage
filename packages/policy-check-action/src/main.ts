import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkPolicyFile, notAFileReason, POLICY_FILE_PATHS, policyFileReason, type PolicyFileProblem } from "@corbits/triage-contracts";
import { escapeData, escapeProperty, runChecks } from "./checks.js";

function annotation(path: string, problem: PolicyFileProblem): string {
  const where = [`file=${escapeProperty(path)}`];
  if (problem.line !== undefined) where.push(`line=${problem.line}`);
  if (problem.column !== undefined) where.push(`col=${problem.column}`);
  return `::error ${where.join(",")}::${escapeData(problem.message)}`;
}

function lint(root: string, repo: string): void {
  for (const path of POLICY_FILE_PATHS) {
    const stats = statSync(join(root, path), { throwIfNoEntry: false });
    if (stats) {
      check(root, path, stats.isFile(), repo);
      return;
    }
  }
  console.log(`No ${POLICY_FILE_PATHS.join(" or ")} to check.`);
}

function check(root: string, path: string, isFile: boolean, repo: string): void {
  if (!isFile) {
    console.log(annotation(path, { message: notAFileReason(path) }));
    process.exitCode = 1;
    return;
  }
  const checked = checkPolicyFile(readFileSync(join(root, path), "utf8"), repo);
  if (checked.ok) {
    console.log(`${path} is valid.`);
    return;
  }
  for (const problem of checked.problems) console.log(annotation(path, problem));
  process.exitCode = 1;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

type Read = (url: URL, init?: RequestInit) => Promise<Response>;

/** GitHub's reads with the job's token, sent to the job's API, which may not be the origin the host steps name. */
function githubReads(api: string, token: string): Read {
  return async function read(url, init) {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(`${api}${url.pathname}${url.search}`, { ...init, headers });
  };
}

/** The policy on the pull request's base branch, never the change's own, which could loosen its rules. */
async function basePolicy(read: Read, repo: string, base: string): Promise<{ path: string; text: string } | undefined> {
  for (const path of POLICY_FILE_PATHS) {
    const url = new URL(`https://api.github.com/repos/${repo}/contents/${path}`);
    url.searchParams.set("ref", base);
    const res = await read(url, { headers: { accept: "application/vnd.github.raw+json" } });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`reading ${path} at ${base} answered ${res.status}`);
    return { path, text: await res.text() };
  }
  return undefined;
}

type PullRequestEvent = { pull_request: { number: number; head: { sha: string }; base: { sha: string } } };

async function checkPullRequest(repo: string): Promise<void> {
  const { pull_request: pull } = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8")) as PullRequestEvent;
  const read = githubReads(env("GITHUB_API_URL"), env("GITHUB_TOKEN"));
  const file = await basePolicy(read, repo, pull.base.sha);
  if (!file) {
    console.log("The base branch has no policy, so no rules ran.");
    return;
  }
  const checked = checkPolicyFile(file.text, repo);
  if (!checked.ok) {
    console.log(`::warning::${escapeData(`${file.path} on the base branch cannot be read, so no rules ran:\n${policyFileReason(checked.problems)}`)}`);
    return;
  }
  if (checked.policy.extends !== undefined) {
    console.log(`${file.path} on the base branch extends another policy, which this Action does not read, so no rules ran.`);
    return;
  }
  const report = await runChecks(checked.policy, { repo, number: pull.number, headSha: pull.head.sha }, read);
  for (const line of report.annotations) console.log(line);
  appendFileSync(env("GITHUB_STEP_SUMMARY"), `${report.summary.join("\n")}\n`);
  if (report.failed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [root, repo] = process.argv.slice(2);
  if (!root || !repo) throw new Error("Usage: main.ts <repository root> <owner/name>");
  lint(root, repo);
  if (process.env.GITHUB_EVENT_NAME === "pull_request") await checkPullRequest(repo);
}

await main();
