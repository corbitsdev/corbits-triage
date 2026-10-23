// Risk backtest: walks each repository's first-parent history at a pinned commit and asks, for every change, whether
// the regression-risk signals (read only from history before it) flag it, and whether it regressed: a fix or revert
// within 14 days rewrote one of its lines (blame on the fix's parent). Prints each signal's lift over the base rate at
// several thresholds. Fan-in (files outside the change referencing an export it changes) needs a checkout, so it is
// measured here for code review and not read by the rule. Reads public git history only; no model is asked.
//
//   bun run eval:risk   (in packages/triage-workflows)
import { existsSync } from "node:fs";
import { FIX_MESSAGE, fixCount, historyPaths, migrationPaths } from "../src/logic/risk.js";
import { DEFAULT_RISK } from "../../triage-contracts/src/check-pack.js";

const REPOS: Record<string, string> = {
  "corbitsdev/corbits-triage": "5938a648ae45ec48f8ccda1a25f84f18e1ff607c",
  "honojs/hono": "5ca49b0720755c585c9a9835f0a479ceea36fb52",
};
const WINDOW_SECONDS = 14 * 24 * 60 * 60;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

const cache = `${new URL(".", import.meta.url).pathname}.cache`;

function git(dir: string, args: string[]): string {
  const out = Bun.spawnSync(["git", "-C", dir, ...args], { maxBuffer: 1 << 30 });
  if (out.exitCode !== 0 && out.exitCode !== 1) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
  return out.stdout.toString();
}

function clone(repo: string, sha: string): string {
  const dir = `${cache}/${repo.replace("/", "__")}`;
  if (!existsSync(dir)) {
    const out = Bun.spawnSync(["git", "clone", "--quiet", "--bare", `https://github.com/${repo}.git`, dir]);
    if (out.exitCode !== 0) throw new Error(`clone ${repo}: ${out.stderr.toString()}`);
  }
  git(dir, ["cat-file", "-e", sha]);
  return dir;
}

interface Change {
  sha: string;
  message: string;
  paths: string[];
  time: number;
}

/** Oldest first. */
function changes(dir: string, head: string): Change[] {
  const out = git(dir, ["log", "--first-parent", "--diff-merges=first-parent", "--name-only", "--format=%x02%H%x03%ct%x03%B%x04", head]);
  return out
    .split("\x02")
    .slice(1)
    .map(function parse(chunk) {
      const [sha, time, rest] = chunk.split("\x03") as [string, string, string];
      const [message, names] = rest.split("\x04") as [string, string];
      return { sha, time: Number(time), message, paths: names.split("\n").filter(Boolean) };
    })
    .reverse();
}

/** Old-side line ranges each file's hunks rewrote or removed. */
function rewritten(dir: string, sha: string): Map<string, string[]> {
  const ranges = new Map<string, string[]>();
  let path: string | null = null;
  for (const line of git(dir, ["diff", "-U0", "--no-renames", `${sha}^1`, sha]).split("\n")) {
    if (line.startsWith("--- ")) path = line === "--- /dev/null" ? null : line.slice(6).replace(/\t$/, "");
    const hunk = /^@@ -(\d+)(?:,(\d+))?/.exec(line);
    if (!hunk || !path) continue;
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) ranges.set(path, [...(ranges.get(path) ?? []), `${hunk[1]},+${count}`]);
  }
  return ranges;
}

/** Changes a fix within the window rewrote a line of. */
function regressed(dir: string, all: Change[]): Set<string> {
  const byFirstParent = new Map(all.map((c) => [c.sha, c]));
  const hit = new Set<string>();
  for (const fix of all) {
    if (!FIX_MESSAGE.test(fix.message)) continue;
    for (const [path, ranges] of rewritten(dir, fix.sha)) {
      const args = ["blame", "--first-parent", "-s", "-l", ...ranges.flatMap((r) => ["-L", r]), `${fix.sha}^1`, "--", path];
      for (const line of git(dir, args).split("\n")) {
        const origin = byFirstParent.get(line.slice(0, 40).replace(/^\^/, ""));
        if (origin && origin.sha !== fix.sha && fix.time - origin.time <= WINDOW_SECONDS) hit.add(origin.sha);
      }
    }
  }
  return hit;
}

/** The most fixes on one changed file in the window before the change, as the rule reads them from the host. */
function hottest(change: Change, earlier: Change[]): number {
  const recent = earlier.filter((c) => change.time - c.time <= DEFAULT_RISK.hotFileDays * 24 * 60 * 60);
  const counts = historyPaths(change.paths).map((path) => fixCount(recent.filter((c) => c.paths.includes(path)).map((c) => c.message)));
  return Math.max(0, ...counts);
}

const EXPORT_DECLARATION = /^[+-]\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** Names of exported declarations a diff adds, removes or rewrites. */
function changedExports(patch: string): string[] {
  return [...new Set(patch.split("\n").flatMap((line) => EXPORT_DECLARATION.exec(line)?.[1] ?? []))];
}

function fanIn(dir: string, change: Change): number {
  const sources = change.paths.filter((p) => SOURCE.test(p));
  if (!sources.length) return 0;
  const names = changedExports(git(dir, ["diff", "-U0", `${change.sha}^1`, change.sha, "--", ...sources]));
  if (!names.length) return 0;
  const own = new Set(change.paths);
  const files = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  const out = git(dir, ["grep", "-w", "-F", "-o", ...names.flatMap((n) => ["-e", n]), `${change.sha}^1`, "--", "*.ts", "*.tsx", "*.js", "*.mjs"]);
  for (const line of out.split("\n")) {
    const [, path, name] = line.split(":");
    if (path && name && !own.has(path)) files.get(name)?.add(path);
  }
  return Math.max(...[...files.values()].map((s) => s.size));
}

interface Row {
  hot: number;
  fanIn: number;
  migration: boolean;
  regressed: boolean;
}

function lift(rows: Row[], flagged: (r: Row) => boolean) {
  const base = rows.filter((r) => r.regressed).length / rows.length;
  const hits = rows.filter(flagged);
  const rate = hits.length ? hits.filter((r) => r.regressed).length / hits.length : 0;
  return { flagged: hits.length, "flagged %": `${Math.round((hits.length / rows.length) * 100)}%`, "regressed %": `${Math.round(rate * 100)}%`, lift: hits.length ? (rate / base).toFixed(2) : "-" };
}

for (const [repo, head] of Object.entries(REPOS)) {
  const dir = clone(repo, head);
  const all = changes(dir, head);
  const hit = regressed(dir, all);
  const settled = all.filter((c) => all.at(-1)!.time - c.time > WINDOW_SECONDS).slice(1);
  const rows: Row[] = settled.map(function row(change) {
    const earlier = all.slice(0, all.indexOf(change));
    return {
      hot: hottest(change, earlier),
      fanIn: fanIn(dir, change),
      migration: migrationPaths(change.paths, DEFAULT_RISK.migrationGlobs).length > 0,
      regressed: hit.has(change.sha),
    };
  });
  const base = rows.filter((r) => r.regressed).length;
  console.log(`\n${repo} at ${head.slice(0, 8)}: ${rows.length} changes, ${base} regressed within 14 days (base rate ${Math.round((base / rows.length) * 100)}%)`);
  console.table({
    ...Object.fromEntries([2, 3, 4, 5, 8].map((t) => [`hot file ≥ ${t} fixes`, lift(rows, (r) => r.hot >= t)])),
    ...Object.fromEntries([1, 3, 5, 10, 20].map((t) => [`fan-in ≥ ${t} files`, lift(rows, (r) => r.fanIn >= t)])),
    migration: lift(rows, (r) => r.migration),
    "rule defaults": lift(rows, (r) => r.hot >= DEFAULT_RISK.hotFileFixes || r.migration),
  });
}
