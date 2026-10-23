import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { CONVENTIONAL_FIELDS, NO_CHANGES_REQUESTED, NOT_A_DRAFT, POLICY_FILE_PATHS, type CheckPack } from "@corbits/triage-contracts";
import type { Skipped } from "./checks.js";

/** The number the local change is read as; any number names it, since only it is served. */
export const LOCAL_NUMBER = 1;

export interface ChangedFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed";
  additions: number;
  deletions: number;
  previous_filename?: string;
  patch?: string;
}

/** The working tree's change against the base: its head, commits and files, as a pull request from it would show them. */
export interface LocalChange {
  repo: string;
  base: string;
  branch: string;
  headSha: string;
  commits: string[];
  files: ChangedFile[];
  /** Where each changed file's text is read: the working tree, or the head commit. */
  root: string;
  workingTree: boolean;
}

function run(root: string, args: string[], ok: readonly number[] = [0]): string {
  const result = Bun.spawnSync(["git", "-c", "core.quotePath=false", ...args], { cwd: root, stderr: "pipe" });
  if (!ok.includes(result.exitCode)) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

export function repositoryRoot(cwd: string): string {
  return run(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/** The branch origin's HEAD names, which is the repository's default branch. */
export function defaultBase(root: string): string {
  return run(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
}

/** `owner/name` from origin's URL, over https or ssh. */
function repoName(root: string): string {
  const url = run(root, ["remote", "get-url", "origin"]).trim();
  const name = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1];
  if (!name) throw new Error(`cannot read owner/name from origin ${url}`);
  return name;
}

/** The policy on the base, never the change's own, which could loosen its rules. */
export function basePolicy(root: string, base: string): { path: string; text: string } | undefined {
  for (const path of POLICY_FILE_PATHS) {
    if (run(root, ["ls-tree", "--name-only", base, "--", path]).trim() !== path) continue;
    return { path, text: run(root, ["show", `${base}:${path}`]) };
  }
  return undefined;
}

type Named = Pick<ChangedFile, "filename" | "status" | "previous_filename">;

/** `git diff --name-status -z`: a status, then one path, or the old and new paths of a rename. */
function namedFiles(listing: string): Named[] {
  const fields = listing.split("\0");
  const named: Named[] = [];
  for (let at = 0; fields[at];) {
    const code = fields[at]![0];
    if (code === "R") {
      named.push({ filename: fields[at + 2]!, status: "renamed", previous_filename: fields[at + 1]! });
      at += 3;
      continue;
    }
    let status: ChangedFile["status"] = "modified";
    if (code === "A") status = "added";
    else if (code === "D") status = "removed";
    named.push({ filename: fields[at + 1]!, status });
    at += 2;
  }
  return named;
}

/** The hunks of one file's `git diff` section, as GitHub's `patch` and line counts; a binary or mode-only change has none. */
function hunks(section: string): Pick<ChangedFile, "additions" | "deletions" | "patch"> {
  const lines = section.split("\n");
  const start = lines.findIndex((line) => line.startsWith("@@"));
  const body = start === -1 ? [] : lines.slice(start);
  while (body.at(-1) === "") body.pop();
  return {
    additions: body.filter((line) => line.startsWith("+")).length,
    deletions: body.filter((line) => line.startsWith("-")).length,
    ...(body.length > 0 && { patch: body.join("\n") }),
  };
}

/** Names come from `--name-status -z`, never the patch headers, which git quotes or pads; its sections follow the same order. */
function diffFiles(root: string, args: string[]): ChangedFile[] {
  const named = namedFiles(run(root, ["diff", "-M", "--no-ext-diff", "--name-status", "-z", ...args]));
  const sections = run(root, ["diff", "-M", "--no-ext-diff", "--no-color", ...args]).split(/^diff --git /m).filter(Boolean);
  if (sections.length !== named.length) throw new Error(`git diff listed ${named.length} files but showed ${sections.length}`);
  return named.map((file, index) => ({ ...file, ...hunks(sections[index]!) }));
}

/** The branch a ref names, without its remote: `origin/main` is `main`. */
function branchName(root: string, ref: string): string {
  const full = run(root, ["rev-parse", "--symbolic-full-name", ref]).trim();
  if (full.startsWith("refs/remotes/")) return full.split("/").slice(3).join("/");
  if (full.startsWith("refs/heads/")) return full.slice("refs/heads/".length);
  return ref;
}

/** The changes since the base: the commits only, or with the working tree, which adds staged, unstaged and untracked changes. */
export function readChange(root: string, base: string, workingTree: boolean): LocalChange {
  const mergeBase = run(root, ["merge-base", base, "HEAD"]).trim();
  const tracked = diffFiles(root, [mergeBase, ...(workingTree ? [] : ["HEAD"])]);
  const untracked = workingTree ? run(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean) : [];
  // --no-index answers 1 when the files differ, which a new file always does.
  const fresh = untracked.map((path): ChangedFile => ({ filename: path, status: "added", ...hunks(run(root, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", path], [1])) }));
  return {
    repo: repoName(root),
    base: branchName(root, base),
    branch: run(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    headSha: run(root, ["rev-parse", "HEAD"]).trim(),
    commits: run(root, ["log", "--reverse", "--format=%B%x00", `${mergeBase}..HEAD`]).split("\0").map((message) => message.trim()).filter(Boolean),
    files: [...tracked, ...fresh],
    root,
    workingTree,
  };
}

/** A changed file's text as the change has it, or undefined when it has none; a symlink's text is its target, as git keeps it. */
function changedText(change: LocalChange, path: string): string | undefined {
  if (!change.files.some((file) => file.filename === path && file.status !== "removed")) return undefined;
  if (change.workingTree) {
    const file = join(change.root, path);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return undefined;
    return stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file, "utf8");
  }
  return run(change.root, ["show", `HEAD:${path}`]);
}

/** GitHub's reads for the local change, served as GitHub would answer them for a pull request from it. */
export function localGithub(change: LocalChange): (url: URL) => Promise<Response> {
  const repo = `/repos/${change.repo}`;
  const pull = {
    number: LOCAL_NUMBER,
    title: "",
    body: "",
    state: "open",
    draft: false,
    // no-merge-conflicts is not run locally; a null here would make the reader wait for GitHub to compute it.
    mergeable: true,
    head: { sha: change.headSha, ref: change.branch },
    base: { ref: change.base },
    additions: change.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: change.files.reduce((sum, file) => sum + file.deletions, 0),
    changed_files: change.files.length,
    labels: [],
    requested_reviewers: [],
    requested_teams: [],
    assignees: [],
  };
  return async function read(url) {
    const path = url.pathname;
    if (path === repo) return Response.json({ default_branch: change.base });
    if (path === `${repo}/pulls/${LOCAL_NUMBER}`) return Response.json(pull);
    if (path === `${repo}/pulls/${LOCAL_NUMBER}/commits`) return Response.json(change.commits.map((message) => ({ commit: { message } })));
    if (path === `${repo}/pulls/${LOCAL_NUMBER}/reviews` || path === `${repo}/issues/${LOCAL_NUMBER}/comments`) return Response.json([]);
    if (path === `${repo}/commits/${change.headSha}/check-runs`) return Response.json({ check_runs: [] });
    if (path === `${repo}/pulls/${LOCAL_NUMBER}/files`) {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json(change.files.slice((page - 1) * perPage, page * perPage));
    }
    const contents = `${repo}/contents/`;
    if (path.startsWith(contents) && url.searchParams.get("ref") === change.headSha) {
      const text = changedText(change, path.slice(contents.length).split("/").map(decodeURIComponent).join("/"));
      if (text !== undefined) return new Response(text);
    }
    return new Response(null, { status: 404 });
  };
}

const ON_HOST = "needs the pull request on its host";

/** Rules that read what only the host knows: its CI, mergeability, reviews, default-branch fix history and the pull request's own title and description. */
export function hostOnly(pack: CheckPack): Skipped[] {
  const described = pack.custom.flatMap((row) => (row.kind === "text" && row.fields.some((field) => field !== "commits") ? [row.id] : []));
  const titled = (pack.checks["conventional-commits"]?.fields ?? CONVENTIONAL_FIELDS).includes("title") ? ["conventional-commits"] : [];
  return ["ci-green", "no-merge-conflicts", "linked-issue", "hidden-content", "regression-risk", NOT_A_DRAFT, NO_CHANGES_REQUESTED, ...titled, ...described].map((id) => ({ id, why: ON_HOST }));
}
