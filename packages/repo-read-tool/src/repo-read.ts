import { createReadStream, type Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { RE2JS } from "re2js";
import { clip, linePage, rangeEnd, LINE_PREFIX_CHARS, MAX_LINES } from "./lines";

export const MAX_MATCHES = 100;
export const MAX_ENTRIES = 500;

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

/** Null marks binary content; paged reads retain only the displayed prefix of each line. */
async function* fileLines(file: string, prefixOnly = false): AsyncGenerator<string | null> {
  let pending = "";
  for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
    const text = String(chunk);
    if (text.includes("\0")) {
      yield null;
      return;
    }
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      pending += text.slice(start, end);
      if (prefixOnly) pending = pending.slice(0, LINE_PREFIX_CHARS);
      if (newline < 0) break;
      yield pending;
      pending = "";
      start = newline + 1;
    }
  }
  yield pending;
}

/** Lines start..end (1-based, inclusive) of a text file, numbered and paged as `linesOf` pages them. */
export async function readLines(root: string, path: string, start = 1, end = start + MAX_LINES - 1) {
  const file = await confine(root, path);
  if (!(await stat(file)).isFile()) throw new Error(`${path} is not a file`);
  const to = rangeEnd(start, end);
  const lines: string[] = [];
  let totalLines = 0;
  for await (const line of fileLines(file, true)) {
    if (line === null) throw new Error(`${path} is binary`);
    totalLines++;
    if (totalLines >= start && totalLines <= to) lines.push(line);
  }
  return linePage(path, lines, start, totalLines);
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
    const found: typeof matches = [];
    let lineNumber = 0;
    for await (const line of fileLines(file)) {
      if (line === null) {
        found.length = 0;
        break;
      }
      lineNumber++;
      if (matches.length + found.length > MAX_MATCHES || !re.matcher(line).find()) continue;
      found.push({ path, line: lineNumber, text: clip(line) });
    }
    matches.push(...found);
    if (matches.length > MAX_MATCHES) return { matches: matches.slice(0, MAX_MATCHES), truncated: true };
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
