import type { LineCitation } from "@corbits/triage-contracts";

/** The most of one file's patch the judge reads. */
export const MAX_PATCH_INPUT_CHARS = 65_536;
const MAX_PATH_CHARS = 512;

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)?)`, "g");
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function removeControls(value: string): string {
  let clean = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 9 || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159)) continue;
    clean += character;
  }
  return clean;
}

function safeText(value: string): string {
  return removeControls(value
    .replace(/\r\n?/g, "\n")
    .replace(ANSI, "")
    .replace(BIDI, ""));
}

function safeInline(value: string, limit: number): string {
  return safeText(value).replace(/\s+/g, " ").trim().slice(0, limit);
}

export function boundedPath(value: string): string {
  return safeInline(value, MAX_PATH_CHARS);
}

type Hunk = {
  oldStart: number;
  newStart: number;
  lines: string[];
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)?$/;

function readablePatch(patch: string): string {
  return safeText(patch.slice(0, MAX_PATCH_INPUT_CHARS));
}

export function patchHunks(patch: string): string[] {
  const readable = readablePatch(patch);
  if (!readable) return [];
  const hunks = hunksOf(readable);
  return hunks.length > 0 ? hunks.map((hunk) => hunk.lines.join("\n")) : [readable];
}

export function hunkCitations(path: string, patch: string, previousPath = path): LineCitation[] {
  return hunksOf(readablePatch(patch)).map((hunk) => citation(path, previousPath, hunk));
}

function range(lines: number[]): { start: number; end: number } | undefined {
  return lines.length > 0 ? { start: lines[0]!, end: lines.at(-1)! } : undefined;
}

function hunkLines(hunk: Hunk): { added: number[]; removed: number[] } {
  const added: number[] = [];
  const removed: number[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.lines.slice(1)) {
    if (line.startsWith("+")) added.push(newLine++);
    else if (line.startsWith("-")) removed.push(oldLine++);
    else if (!line.startsWith("\\")) {
      oldLine++;
      newLine++;
    }
  }
  return { added, removed };
}

/** The new file's line numbers, from 1, that the patch adds. */
export function addedLines(patch: string): Set<number> {
  return new Set(hunksOf(readablePatch(patch)).flatMap((hunk) => hunkLines(hunk).added));
}

function citation(path: string, previousPath: string, hunk: Hunk): LineCitation {
  const { added, removed } = hunkLines(hunk);
  const addedRange = range(added);
  const removedRange = range(removed);
  return { path, ...(addedRange ? { added: addedRange } : {}), ...(removedRange ? { removed: { path: previousPath, ...removedRange } } : {}) };
}

function hunksOf(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [line] };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return hunks;
}
