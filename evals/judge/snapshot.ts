// Freezes the labelled pull requests into pulls/<number>.json as GitHub serves them, with the repository's docs at the
// base, and writes cases.jsonl: each pull request as merged, without its docs where it needs them, and the
// labelled mixes of two unrelated pull requests.
//
//   bun evals/judge/snapshot.ts
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDocPath } from "../../packages/triage-contracts/src/paths.js";
import { variant, type CaseInput, type Expected, type FileRow, type JudgeCase, type Labels, type Snapshot, type StoredSnapshot } from "./cases.js";

const here = new URL(".", import.meta.url).pathname;
const labels = JSON.parse(readFileSync(`${here}labels.json`, "utf8")) as Labels;
const { repo } = labels;

/** Ticket ids in old bodies and docs stay out of the repository. */
function redacted(text: string): string {
  return text.replace(/\bCL-\d+/g, "CL-XXXX");
}

function gh<T>(path: string, accept = "application/vnd.github+json"): T {
  const out = Bun.spawnSync(["gh", "api", "-H", `Accept: ${accept}`, path]);
  if (out.exitCode !== 0) throw new Error(`gh api ${path}: ${out.stderr.toString()}`);
  return JSON.parse(out.stdout.toString()) as T;
}

function ghPages<T>(path: string): T[] {
  const out = Bun.spawnSync(["gh", "api", "--paginate", "--slurp", path]);
  if (out.exitCode !== 0) throw new Error(`gh api ${path}: ${out.stderr.toString()}`);
  return (JSON.parse(out.stdout.toString()) as T[][]).flat();
}

function raw(path: string, ref: string): string {
  const out = Bun.spawnSync(["gh", "api", "-H", "Accept: application/vnd.github.raw+json", `repos/${repo}/contents/${path}?ref=${ref}`]);
  if (out.exitCode !== 0) throw new Error(`gh api contents ${path}@${ref}: ${out.stderr.toString()}`);
  return out.stdout.toString();
}

function docsAt(ref: string): Record<string, string> {
  const tree = gh<{ tree: Array<{ path: string; type: string }> }>(`repos/${repo}/git/trees/${ref}?recursive=1`).tree;
  return Object.fromEntries(tree.filter((row) => row.type === "blob" && isDocPath(row.path)).map((row) => [row.path, redacted(raw(row.path, ref))]));
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

function snapshot(number: number): Snapshot {
  const pull = gh<any>(`repos/${repo}/pulls/${number}`);
  return {
    repo,
    number,
    title: redacted(pull.title),
    body: redacted(pull.body ?? ""),
    author: pull.user.login,
    commits: ghPages<any>(`repos/${repo}/pulls/${number}/commits?per_page=100`).map((c) => redacted(String(c.commit.message).split("\n", 1)[0]!)),
    files: ghPages<any>(`repos/${repo}/pulls/${number}/files?per_page=100`).map(fileRow),
    docs: docsAt(pull.base.sha),
  };
}

/** The verdict fails when any judged rule is expected to fail. */
function expected(pr: Snapshot, needsDocs: boolean, focused: Expected["focused"]): Expected {
  const docs = needsDocs && !pr.files.some((file) => isDocPath(file.filename)) ? "fail" : "pass";
  return { docs, focused, verdict: docs === "fail" || focused === "fail" ? "fail" : "pass" };
}

/** Writes each doc once under its content hash and points the snapshot at it. */
function stored(pr: Snapshot): StoredSnapshot {
  const docs = Object.fromEntries(Object.entries(pr.docs).map(([path, text]) => {
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    writeFileSync(`${here}docs/${hash}.md`, text);
    return [path, hash];
  }));
  return { ...pr, docs };
}

mkdirSync(`${here}pulls`, { recursive: true });
mkdirSync(`${here}docs`, { recursive: true });
const pulls = new Map<number, Snapshot>();
for (const key of Object.keys(labels.pulls)) {
  const pr = snapshot(Number(key));
  pulls.set(pr.number, pr);
  writeFileSync(`${here}pulls/${key}.json`, `${JSON.stringify(stored(pr), null, 1)}\n`);
  console.log(`#${key}: ${pr.files.length} files, ${Object.keys(pr.docs).length} docs`);
}

const cases: JudgeCase[] = [];
function add(id: string, input: CaseInput, needsDocs: boolean, focused: Expected["focused"]) {
  const base = pulls.get(input.pull)!;
  const pr = variant(base, input, input.mix === undefined ? undefined : pulls.get(input.mix));
  cases.push({ name: id, input, expect: expected(pr, needsDocs, focused) });
}
for (const [key, label] of Object.entries(labels.pulls)) {
  const pull = Number(key);
  const pr = pulls.get(pull)!;
  add(key, { pull }, label.needsDocs, "pass");
  if (label.needsDocs && pr.files.some((file) => isDocPath(file.filename))) add(`${key}-no-docs`, { pull, drop: "docs" }, true, "pass");
}
for (const [pull, mix] of labels.mixes) {
  add(`${pull}+${mix}`, { pull, mix }, labels.pulls[pull]!.needsDocs || labels.pulls[mix]!.needsDocs, "fail");
}
for (const [pull, mix] of labels.describedMixes) {
  add(`${pull}+${mix}-described`, { pull, mix, described: true }, labels.pulls[pull]!.needsDocs || labels.pulls[mix]!.needsDocs, "fail");
}
writeFileSync(`${here}cases.jsonl`, `${cases.map((row) => JSON.stringify(row)).join("\n")}\n`);
console.log(`${cases.length} cases`);
