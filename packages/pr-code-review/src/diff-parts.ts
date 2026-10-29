import { posix } from "node:path";
import { diffFiles, type DiffFileStatus } from "@corbits/common/diff-files";
import { DIFF_MOUNT } from "@corbits/repo-read-tool";
import type { UnreadLines } from "@corbits/triage-contracts";
import type { LinesRead } from "./lines-read.js";

/** Where the read tools show the folder the checkout action writes the pull request's diff into, one patch per changed file. */
export const DIFF_DIR = DIFF_MOUNT;

/** Lists every changed file of the diff: its path, status, line count and the patch files that hold it. */
export const DIFF_INDEX = `${DIFF_DIR}/index.jsonl`;

/**
 * A file's patch past this many bytes is split into numbered parts, each well under what the read tools read whole; a
 * part ends at a line end, or inside a line longer than this.
 */
export const MAX_PART_BYTES = 1_500_000;

export interface DiffPart {
  path: string;
  lines: number;
  text: string;
}

export interface IndexedFile {
  path: string;
  status: DiffFileStatus;
  lines: number;
  /** None for a deleted file, which leaves nothing to read at the head. */
  parts: DiffPart[];
}

function linesIn(text: string): string[] {
  return text.split(/(?<=\n)/).filter((line) => line !== "");
}

/** `line` cut into pieces of at most MAX_PART_BYTES each, never inside a character. */
function pieces(line: string): string[] {
  const bytes = Buffer.from(line);
  const cut: string[] = [];
  let from = 0;
  while (from < bytes.length) {
    let to = Math.min(from + MAX_PART_BYTES, bytes.length);
    // A UTF-8 continuation byte is 10xxxxxx; cutting before one would split its character.
    while (to < bytes.length && (bytes[to]! & 0xc0) === 0x80) to--;
    cut.push(bytes.subarray(from, to).toString());
    from = to;
  }
  return cut;
}

/** The patch cut into texts of at most MAX_PART_BYTES each, at line ends, and inside a line only when it is longer. */
function split(patch: string): string[] {
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const piece of linesIn(patch).flatMap(pieces)) {
    const size = Buffer.byteLength(piece);
    if (part !== "" && bytes + size > MAX_PART_BYTES) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    part += piece;
    bytes += size;
  }
  return part === "" ? parts : [...parts, part];
}

function partPath(file: number, part: number, of: number): string {
  const name = String(file).padStart(4, "0");
  return `${DIFF_DIR}/${of === 1 ? name : `${name}-${part}`}.patch`;
}

/** Each changed file of the diff with the patch files the checkout holds it in; a deleted file has none. */
export function indexedFiles(diff: string): IndexedFile[] {
  return diffFiles(diff).map(function indexed({ path, status, patch }, i) {
    const lines = linesIn(patch).length;
    if (status === "deleted") return { path, status, lines, parts: [] };
    const texts = split(patch);
    return { path, status, lines, parts: texts.map((text, at) => ({ path: partPath(i + 1, at + 1, texts.length), lines: linesIn(text).length, text })) };
  });
}

/** The index file's text: one JSON line per changed file. */
export function indexText(files: readonly IndexedFile[]): string {
  return files.map(({ path, status, lines, parts }) => `${JSON.stringify({ path, status, lines, patches: parts.map((part) => part.path) })}\n`).join("");
}

// A finder's reply ends with the lines of each patch file it was shown, so the review can tell whether the diff was read whole.
const SHOWN_TAG = /\n<diff_shown>(.*)<\/diff_shown>$/;

/** The line ranges of `lines`, ascending. */
function rangesOf(lines: ReadonlySet<number>): [number, number][] {
  const ranges: [number, number][] = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last[1] === line - 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}

/** The tag naming the lines of each patch file a reader was shown, under each file's one normal path. */
export function shownTag(read: LinesRead): string {
  const merged: LinesRead = new Map();
  for (const [path, lines] of read) {
    const normal = posix.normalize(path);
    if (!normal.startsWith(`${DIFF_DIR}/`)) continue;
    const seen = merged.get(normal);
    if (seen) for (const line of lines) seen.add(line);
    else merged.set(normal, new Set(lines));
  }
  const shown = Object.fromEntries([...merged].map(([path, lines]) => [path, rangesOf(lines)]));
  return `\n<diff_shown>${JSON.stringify(shown)}</diff_shown>`;
}

/** The lines of each patch file a reply's tag names; none when it has no tag. */
export function shownIn(reply: string): LinesRead {
  const match = SHOWN_TAG.exec(reply);
  const read: LinesRead = new Map();
  if (!match) return read;
  for (const [path, ranges] of Object.entries(JSON.parse(match[1]!) as Record<string, [number, number][]>)) {
    const lines = new Set<number>();
    for (const [from, to] of ranges) for (let line = from; line <= to; line++) lines.add(line);
    read.set(path, lines);
  }
  return read;
}

/** Past this many files, a review's unread files are counted but not listed. */
const MAX_UNREAD_FILES = 50;

/** Past this many ranges, a file's unread lines run to the end of its last range, so none is left out. */
const MAX_UNREAD_RANGES = 20;

/** The lines of the file's patch none of `reads` showed; a line a part continues from the one before is that same line. */
function unreadOf(file: IndexedFile, reads: readonly LinesRead[]): Set<number> {
  const unread = new Set<number>();
  let started = 0;
  let continued = false;
  for (const part of file.parts) {
    const first = continued ? started : started + 1;
    for (let line = 1; line <= part.lines; line++) if (!reads.some((read) => read.get(part.path)?.has(line))) unread.add(first + line - 1);
    started = first + part.lines - 1;
    continued = !part.text.endsWith("\n");
  }
  return unread;
}

/** At most MAX_UNREAD_RANGES of `ranges`, the last running to the end of the last of them. */
function capped(ranges: [number, number][]): [number, number][] {
  if (ranges.length <= MAX_UNREAD_RANGES) return ranges;
  const kept = ranges.slice(0, MAX_UNREAD_RANGES);
  kept[MAX_UNREAD_RANGES - 1] = [kept[MAX_UNREAD_RANGES - 1]![0], ranges.at(-1)![1]];
  return kept;
}

/** The first MAX_UNREAD_FILES changed files with patch lines none of `reads` showed, those lines, and how many files have any. */
export function unreadLines(files: readonly IndexedFile[], reads: readonly LinesRead[]): { unread: UnreadLines[]; unreadFiles: number } {
  const unread = files.flatMap(function unreadIn(file) {
    const lines = unreadOf(file, reads);
    return lines.size > 0 ? [{ path: file.path, lines: capped(rangesOf(lines)) }] : [];
  });
  return { unread: unread.slice(0, MAX_UNREAD_FILES), unreadFiles: unread.length };
}
