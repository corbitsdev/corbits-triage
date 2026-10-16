import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { RE2JS } from "re2js";

export const MAX_LINES = 400;
export const MAX_MATCHES = 100;
export const MAX_ENTRIES = 500;
const MAX_LINE_CHARS = 500;
const MAX_FILE_BYTES = 2_000_000;

/** The real path of `path` under root; one that resolves outside it, through `..`, an absolute path or a symlink, is refused. */
async function confine(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  let real: string;
  try {
    real = await realpath(resolve(base, path));
  } catch {
    throw new Error(`${path} does not exist`);
  }
  const rel = relative(base, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${path} is outside the repository`);
  return real;
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

async function textOf(file: string): Promise<string | undefined> {
  if ((await stat(file)).size > MAX_FILE_BYTES) return undefined;
  const text = await readFile(file, "utf8");
  return text.includes("\0") ? undefined : text;
}

/** Lines start..end (1-based, inclusive) of a text file, numbered, at most MAX_LINES of them. */
export async function readLines(root: string, path: string, start = 1, end = start + MAX_LINES - 1) {
  const file = await confine(root, path);
  if (!(await stat(file)).isFile()) throw new Error(`${path} is not a file`);
  const text = await textOf(file);
  if (text === undefined) throw new Error(`${path} is binary or larger than ${MAX_FILE_BYTES} bytes`);
  return linesOf(path, text, start, end);
}

/** Lines start..end (1-based, inclusive) of `text`, numbered, at most MAX_LINES of them. */
export function linesOf(path: string, text: string, start = 1, end = start + MAX_LINES - 1) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error("start and end must be integers");
  if (text.includes("\0")) throw new Error(`${path} is binary`);
  const lines = text.split("\n");
  const from = Math.max(1, start);
  const to = Math.min(lines.length, end, from + MAX_LINES - 1);
  const numbered = lines.slice(from - 1, to).map((line, i) => `${from + i}\t${clip(line)}`);
  return { path, start: from, end: to, totalLines: lines.length, text: numbered.join("\n") };
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort(byName);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function byName(a: Dirent, b: Dirent): number {
  return a.name.localeCompare(b.name);
}

function posixPath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

/** Lines matching an RE2 pattern in the repository's text files, or those matching glob, at most MAX_MATCHES. Symlinks are not followed. */
export async function grep(root: string, pattern: string, glob?: string) {
  const base = await realpath(root);
  const re = RE2JS.compile(pattern);
  const matches: { path: string; line: number; text: string }[] = [];
  for await (const file of walk(base)) {
    const path = posixPath(base, file);
    if (glob && !minimatch(path, glob, { dot: true, matchBase: !glob.includes("/") })) continue;
    const text = await textOf(file);
    if (text === undefined) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!re.matcher(lines[i]!).find()) continue;
      if (matches.length === MAX_MATCHES) return { matches, truncated: true };
      matches.push({ path, line: i + 1, text: clip(lines[i]!) });
    }
  }
  return { matches, truncated: false };
}

function entryType(entry: Dirent): string {
  if (entry.isDirectory()) return "dir";
  if (entry.isSymbolicLink()) return "symlink";
  return "file";
}

/** The entries of a directory, at most MAX_ENTRIES. */
export async function list(root: string, path = ".") {
  const dir = await confine(root, path);
  const entries = (await readdir(dir, { withFileTypes: true })).sort(byName);
  const shown = entries.slice(0, MAX_ENTRIES).map((entry) => ({ name: entry.name, type: entryType(entry) }));
  return { path, entries: shown, truncated: entries.length > MAX_ENTRIES };
}
