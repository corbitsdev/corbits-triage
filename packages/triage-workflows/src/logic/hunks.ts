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

/** A path as the judge's state carries it. */
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

/** A file's patch as the judge reads it: split at hunk headers, whole when it has none, empty when it is. */
export function patchHunks(patch: string): string[] {
  const readable = readablePatch(patch);
  if (!readable) return [];
  const hunks = hunksOf(readable);
  return hunks.length > 0 ? hunks.map((hunk) => hunk.lines.join("\n")) : [readable];
}

/** The lines each hunk of a file's patch changes, in `patchHunks` order; empty when the patch has no hunk headers. */
export function hunkCitations(path: string, patch: string, previousPath = path): LineCitation[] {
  return hunksOf(readablePatch(patch)).map((hunk) => citation(path, previousPath, hunk));
}

function range(lines: number[]): { start: number; end: number } | undefined {
  return lines.length > 0 ? { start: lines[0]!, end: lines.at(-1)! } : undefined;
}

/** A hunk's added lines in the head file and removed lines in the base file, each first to last. */
function citation(path: string, previousPath: string, hunk: Hunk): LineCitation {
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
