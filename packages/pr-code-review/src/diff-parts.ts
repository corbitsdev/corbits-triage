import { posix } from "node:path";
import { diffFiles, type DiffFileStatus } from "@corbits/common/diff-files";
import type { LinesRead } from "./lines-read.js";

/** Where the checkout action writes the pull request's diff, one patch per changed file, relative to the checkout's root. */
export const DIFF_DIR = ".corbits/diff";

/** Lists every changed file of the diff: its path, status, line count and the patch files that hold it. */
export const DIFF_INDEX = `${DIFF_DIR}/index.jsonl`;

/** A file's patch past this many bytes is split into numbered parts, each well under what the read tools read whole. */
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

/** The patch cut at line ends into texts of at most MAX_PART_BYTES each, or one line alone when it is longer. */
function split(patch: string): string[] {
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const line of linesIn(patch)) {
    const size = Buffer.byteLength(line);
    if (part !== "" && bytes + size > MAX_PART_BYTES) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    part += line;
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

/** The tag naming the lines of each patch file a reader was shown. */
export function shownTag(read: LinesRead): string {
  const shown: Record<string, [number, number][]> = {};
  for (const [path, lines] of read) {
    const normal = posix.normalize(path);
    if (normal.startsWith(`${DIFF_DIR}/`)) shown[normal] = [...(shown[normal] ?? []), ...rangesOf(lines)];
  }
  return `\n<diff_shown>${JSON.stringify(shown)}</diff_shown>`;
}

/** The lines of each patch file a reply's tag names; none when it has no tag. */
export function shownIn(reply: string): LinesRead {
  const match = SHOWN_TAG.exec(reply);
  const read: LinesRead = new Map();
  if (!match) return read;
  for (const [path, ranges] of Object.entries(JSON.parse(match[1]!) as Record<string, [number, number][]>)) {
    const lines = read.get(path) ?? new Set<number>();
    for (const [from, to] of ranges) for (let line = from; line <= to; line++) lines.add(line);
    read.set(path, lines);
  }
  return read;
}

function partShown(part: DiffPart, reads: readonly LinesRead[]): boolean {
  for (let line = 1; line <= part.lines; line++) if (!reads.some((read) => read.get(part.path)?.has(line))) return false;
  return true;
}

/** Whether every line of every patch file was shown in at least one of `reads`. */
export function readWhole(files: readonly IndexedFile[], reads: readonly LinesRead[]): boolean {
  return files.every((file) => file.parts.every((part) => partShown(part, reads)));
}
