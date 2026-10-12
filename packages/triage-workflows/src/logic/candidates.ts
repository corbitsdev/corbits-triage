import type { PrFileFacts } from "./checks.js";

const MAX_FILES = 100;
/** The most of one file's patch candidates and the judge read. */
export const MAX_PATCH_INPUT_CHARS = 65_536;
const MAX_CANDIDATES = 200;
const MAX_EVIDENCE_CHARS = 4_096;
const MAX_LABEL_CHARS = 160;
const MAX_PATH_CHARS = 512;

export interface ChangeCandidate {
  path: string;
  previousPath?: string;
  status?: string;
  label: string;
  /** The hunk's index in the file's patch, as `patchHunks` splits it; absent when the file has no patch. */
  hunk?: number;
  evidence: string;
}

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

const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const MARKUP = /[@`*~[\]<>|\\]/g;

/** Labels come from the author's code and reach the author comment and the judge's instructions, so they carry no markdown, links or mentions. */
function plainLabel(value: string): string {
  return safeInline(safeText(value).replace(MARKDOWN_LINK, "$1").replace(MARKUP, " "), MAX_LABEL_CHARS);
}

/** A path as candidates and the judge's state carry it. */
export function boundedPath(value: string): string {
  return safeInline(value, MAX_PATH_CHARS);
}

function boundedEvidence(value: string): string {
  return safeText(value).slice(0, MAX_EVIDENCE_CHARS);
}

type Hunk = {
  newStart: number;
  lines: string[];
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)?$/;

function readablePatch(patch: string): string {
  return safeText(patch.slice(0, MAX_PATCH_INPUT_CHARS));
}

/** A file's patch as the hunks candidates point at: split at hunk headers, whole when it has none, empty when it is. */
export function patchHunks(patch: string): string[] {
  const readable = readablePatch(patch);
  if (!readable) return [];
  const hunks = hunksOf(readable);
  return hunks.length > 0 ? hunks.map((hunk) => hunk.lines.join("\n")) : [readable];
}

function hunksOf(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = { newStart: Number(header[2]), lines: [line] };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return hunks;
}

/** The added and removed lines of a hunk, without their markers. */
function changedLines(hunk: Hunk): string[] {
  return hunk.lines.flatMap((line) => (line.startsWith("+") || line.startsWith("-") ? [line.slice(1)] : []));
}

function memberNames(lines: string[]): string[] {
  const member = /(?:^|[,{])\s*["']?(?:name|label|title)["']?\s*:\s*(["'`])([^"'`\r\n]*)\1/g;
  return lines.flatMap((line) => [...line.matchAll(member)].map((match) => match[2] ?? ""));
}

function selectors(lines: string[]): string[] {
  return lines.flatMap(function selector(line) {
    const brace = line.indexOf("{");
    const beforeBrace = brace < 0 ? "" : line.slice(0, brace).trim();
    return beforeBrace && !beforeBrace.startsWith("@") ? [beforeBrace] : [];
  });
}

function declarations(lines: string[]): string[] {
  const declaration = /^\s*(?:(?:export|declare|default|async|abstract)\s+)*(?:(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)|(?:function|class|interface|type|namespace|const|let|var)\s+([A-Za-z_$][\w$]*))/;
  return lines.flatMap(function declared(line) {
    const match = declaration.exec(line);
    return match ? [match[1] ?? match[2] ?? ""] : [];
  });
}

function labelsFor(path: string, hunk: Hunk): string[] {
  const changed = changedLines(hunk);
  const lowerPath = path.toLowerCase();
  let labels: string[] = [];
  if (/\.(?:[cm]?[jt]sx?)$/.test(lowerPath)) labels = memberNames(changed);
  if (labels.length === 0 && /\.(?:css|scss|less)$/.test(lowerPath)) labels = selectors(changed);
  if (labels.length === 0) labels = declarations(changed);
  return [...new Set(labels.map(plainLabel).filter(Boolean))];
}

function coordinateLabel(path: string, line: number): string {
  const suffix = `:${line}`;
  return `${path.slice(0, MAX_LABEL_CHARS - suffix.length)}${suffix}`;
}

/** Every name a hunk touches, joined; a hunk that names nothing is labelled by where it starts. */
function hunkLabel(path: string, hunk: Hunk): string {
  const names = labelsFor(path, hunk);
  return names.length > 0 ? plainLabel(names.join(", ")) : coordinateLabel(path, hunk.newStart);
}

function candidate(file: PrFileFacts, path: string, label: string, evidence: string, hunk?: number): ChangeCandidate {
  const previousPath = typeof file.previousPath === "string" ? boundedPath(file.previousPath) : "";
  const status = typeof file.status === "string" ? safeInline(file.status, MAX_LABEL_CHARS) : "";
  return {
    path,
    ...(previousPath ? { previousPath } : {}),
    ...(status ? { status } : {}),
    label: plainLabel(label),
    ...(hunk === undefined ? {} : { hunk }),
    evidence: boundedEvidence(evidence),
  };
}

/** A pure rename or a binary file has no lines to read, so there is nothing to classify. */
function unchanged(file: PrFileFacts): boolean {
  return file.patch === undefined && file.additions === 0 && file.deletions === 0;
}

/**
 * One candidate per hunk read, in file order. A file whose lines were not all read, because GitHub left out its patch,
 * it was cut, or it falls past MAX_FILES or MAX_CANDIDATES, also gets one candidate without evidence that lists it unread.
 */
export function extractChangeCandidates(files: readonly PrFileFacts[] | undefined): ChangeCandidate[] {
  const candidates: ChangeCandidate[] = [];
  for (const [position, file] of (files ?? []).entries()) {
    if (unchanged(file)) continue;
    const path = boundedPath(file.path);
    const patch = typeof file.patch === "string" ? readablePatch(file.patch) : "";
    const room = position < MAX_FILES ? MAX_CANDIDATES - candidates.length : 0;
    if (patch.length === 0 || room <= 0) {
      candidates.push(candidate(file, path, path, ""));
      continue;
    }
    const hunks = hunksOf(patch);
    if (hunks.length === 0) {
      candidates.push(candidate(file, path, path, patch, 0));
      continue;
    }
    for (const [index, hunk] of hunks.slice(0, room).entries()) candidates.push(candidate(file, path, hunkLabel(path, hunk), hunk.lines.join("\n"), index));
    const cut = file.patchTruncated === true || (file.patch?.length ?? 0) > MAX_PATCH_INPUT_CHARS;
    if (hunks.length > room || cut) candidates.push(candidate(file, path, path, ""));
  }
  return candidates;
}
