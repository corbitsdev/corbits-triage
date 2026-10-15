import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDocPath } from "../../triage-contracts/src/paths.js";
import type { FileRow, Labels, Snapshot } from "./cases.js";

const REPO = "corbitsdev/corbits-triage";

const here = new URL(".", import.meta.url).pathname;
const cacheDir = `${here}.cache/`;
const labels = JSON.parse(readFileSync(`${here}labels.json`, "utf8")) as Labels;

/** Ticket ids in old bodies and docs stay out of the judge's reach. */
function redacted(text: string): string {
  return text.replace(/\bCL-\d+/g, "CL-XXXX");
}

function gh(args: string[]): string {
  const out = Bun.spawnSync(["gh", "api", ...args]);
  if (out.exitCode !== 0) throw new Error(`gh api ${args.join(" ")}: ${out.stderr.toString()}`);
  return out.stdout.toString();
}

function ghJson<T>(path: string): T {
  return JSON.parse(gh([path])) as T;
}

function cached<T>(file: string, fetch: () => T): T {
  const path = `${cacheDir}${file}`;
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T;
  const value = fetch();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return value;
}

function docText(sha: string): string {
  return cached(`blobs/${sha}.json`, () => redacted(gh(["-H", "Accept: application/vnd.github.raw+json", `repos/${REPO}/git/blobs/${sha}`])));
}

function docsAt(ref: string): Record<string, string> {
  const tree = ghJson<{ tree: Array<{ path: string; type: string; sha: string }> }>(`repos/${REPO}/git/trees/${ref}?recursive=1`).tree;
  return Object.fromEntries(tree.filter((row) => row.type === "blob" && isDocPath(row.path)).map((row) => [row.path, docText(row.sha)]));
}

function fileRow(row: any): FileRow {
  return {
    filename: row.filename,
    ...(row.previous_filename ? { previous_filename: row.previous_filename } : {}),
    status: row.status,
    additions: row.additions,
    deletions: row.deletions,
    ...(typeof row.patch === "string" ? { patch: redacted(row.patch) } : {}),
  };
}

/** Files and commits between the shas a pull request was measured at, which later pushes to it do not change. */
function measured(number: number, baseSha: string, headSha: string) {
  const range = `${baseSha}...${headSha}`;
  let compare: any;
  try {
    compare = ghJson<any>(`repos/${REPO}/compare/${range}?per_page=100`);
  } catch (err) {
    throw new Error(`#${number} cannot be compared at ${range}, the shas it was measured at: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (compare.commits.length !== compare.total_commits || compare.files.length >= 300) throw new Error(`#${number}: the comparison at ${range} is truncated`);
  return compare;
}

/** A labelled pull request at the head and base it was measured at, with the repository's docs at that base, fetched on first use into the gitignored `.cache/`; delete that directory to refetch. */
export function fixture(number: number): Snapshot {
  const label = labels.pulls[number];
  if (!label) throw new Error(`#${number} is not labelled in labels.json`);
  const { baseSha, headSha } = label;
  return cached(`pulls/${number}-${headSha}.json`, function fetchPull() {
    const pull = ghJson<any>(`repos/${REPO}/pulls/${number}`);
    const compare = measured(number, baseSha, headSha);
    return {
      repo: REPO,
      number,
      title: redacted(pull.title),
      body: redacted(pull.body ?? ""),
      author: pull.user.login,
      commits: compare.commits.map((c: any) => redacted(String(c.commit.message).split("\n", 1)[0]!)),
      files: compare.files.map(fileRow),
      docs: docsAt(baseSha),
    };
  });
}
