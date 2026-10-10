import type { PrFileFacts } from "./checks.js";

const MAX_FILES = 100;
const MAX_INPUT_CHARS = 65_536;
const MAX_CANDIDATES = 200;
const MAX_EVIDENCE_CHARS = 4_096;
const MAX_LABEL_CHARS = 160;
const MAX_PATH_CHARS = 512;

export interface ChangeCandidate {
  path: string;
  previousPath?: string;
  status?: string;
  label: string;
  evidence: string;
  /** The evidence was cut to fit one decision model request. */
  trimmed?: true;
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

function boundedPath(value: string): string {
  return safeInline(value, MAX_PATH_CHARS);
}

function boundedEvidence(value: string): string {
  return safeText(value).slice(0, MAX_EVIDENCE_CHARS);
}

type Hunk = {
  newStart: number;
  lines: string[];
};

type ChangedLine = {
  index: number;
  source: string;
};

type LabelHit = {
  label: string;
  line: number;
  rawStart: number;
  rawEnd: number;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)?$/;

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

function changedLines(hunk: Hunk): ChangedLine[] {
  return hunk.lines.flatMap(function changed(line, index) {
    return line.startsWith("+") || line.startsWith("-") ? [{ index, source: line.slice(1) }] : [];
  });
}

function memberNames(lines: ChangedLine[]): LabelHit[] {
  const names: LabelHit[] = [];
  const member = /(?:^|[,{])\s*["']?(?:name|label|title)["']?\s*:\s*(["'`])([^"'`\r\n]*)\1/g;
  for (const line of lines) {
    for (const match of line.source.matchAll(member)) {
      const label = match[2] ?? "";
      const rawStart = 1 + (match.index ?? 0) + match[0].lastIndexOf(label);
      names.push({ label, line: line.index, rawStart, rawEnd: rawStart + label.length });
    }
  }
  return names;
}

function selectors(lines: ChangedLine[]): LabelHit[] {
  return lines.flatMap(function selector(line) {
    const brace = line.source.indexOf("{");
    if (brace < 0) return [];
    const beforeBrace = line.source.slice(0, brace).trim();
    const rawStart = 1 + line.source.indexOf(beforeBrace);
    return beforeBrace && !beforeBrace.startsWith("@")
      ? [{ label: beforeBrace, line: line.index, rawStart, rawEnd: rawStart + beforeBrace.length }]
      : [];
  });
}

function declarations(lines: ChangedLine[]): LabelHit[] {
  const names: LabelHit[] = [];
  const declaration = /^\s*(?:(?:export|declare|default|async|abstract)\s+)*(?:(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)|(?:function|class|interface|type|namespace|const|let|var)\s+([A-Za-z_$][\w$]*))/;
  for (const line of lines) {
    const match = declaration.exec(line.source);
    if (match) {
      const label = match[1] ?? match[2] ?? "";
      const rawStart = 1 + (match.index ?? 0) + match[0].lastIndexOf(label);
      names.push({ label, line: line.index, rawStart, rawEnd: rawStart + label.length });
    }
  }
  return names;
}

function labelsFor(path: string, hunk: Hunk): LabelHit[] {
  const changed = changedLines(hunk);
  const lowerPath = path.toLowerCase();
  let labels: LabelHit[] = [];
  if (/\.(?:[cm]?[jt]sx?)$/.test(lowerPath)) labels = memberNames(changed);
  if (labels.length === 0 && /\.(?:css|scss|less)$/.test(lowerPath)) labels = selectors(changed);
  if (labels.length === 0) labels = declarations(changed);
  const seen = new Set<string>();
  return labels.flatMap(function unique(hit) {
    const label = plainLabel(hit.label);
    if (!label || seen.has(label)) return [];
    seen.add(label);
    return [{ ...hit, label }];
  });
}

function coordinateLabel(path: string, line: number): string {
  const suffix = `:${line}`;
  return `${path.slice(0, MAX_LABEL_CHARS - suffix.length)}${suffix}`;
}

function evidenceFor(hunk: Hunk, hit: LabelHit): string {
  const evidence = hunk.lines.join("\n");
  if (evidence.length <= MAX_EVIDENCE_CHARS) return evidence;

  const producingLine = hunk.lines[hit.line] ?? "";
  const lineStart = hunk.lines.slice(0, hit.line).reduce((length, line) => length + line.length + 1, 0);
  if (producingLine.length >= MAX_EVIDENCE_CHARS) {
    const rawStart = lineStart + hit.rawStart;
    const rawEnd = lineStart + hit.rawEnd;
    const rawLength = rawEnd - rawStart;
    const desired = rawStart - Math.floor((MAX_EVIDENCE_CHARS - Math.min(rawLength, MAX_EVIDENCE_CHARS)) / 2);
    const minimum = rawLength <= MAX_EVIDENCE_CHARS ? Math.max(lineStart, rawEnd - MAX_EVIDENCE_CHARS) : lineStart;
    const maximum = rawLength <= MAX_EVIDENCE_CHARS
      ? Math.min(rawStart, lineStart + producingLine.length - MAX_EVIDENCE_CHARS)
      : lineStart + producingLine.length - MAX_EVIDENCE_CHARS;
    const start = Math.max(minimum, Math.min(desired, maximum));
    return evidence.slice(start, start + MAX_EVIDENCE_CHARS);
  }

  const lineEnd = lineStart + producingLine.length;
  const desired = lineStart - Math.floor((MAX_EVIDENCE_CHARS - producingLine.length) / 2);
  const minimum = Math.max(0, lineEnd - MAX_EVIDENCE_CHARS);
  const maximum = Math.min(lineStart, evidence.length - MAX_EVIDENCE_CHARS);
  const start = Math.max(minimum, Math.min(desired, maximum));
  return evidence.slice(start, start + MAX_EVIDENCE_CHARS);
}

function candidate(file: PrFileFacts, path: string, label: string, evidence: string): ChangeCandidate {
  const previousPath = typeof file.previousPath === "string" ? boundedPath(file.previousPath) : "";
  const status = typeof file.status === "string" ? safeInline(file.status, MAX_LABEL_CHARS) : "";
  return {
    path,
    ...(previousPath ? { previousPath } : {}),
    ...(status ? { status } : {}),
    label: plainLabel(label),
    evidence: boundedEvidence(evidence),
  };
}

export function extractChangeCandidates(files: readonly PrFileFacts[] | undefined): ChangeCandidate[] {
  const candidates: ChangeCandidate[] = [];
  for (const file of (files ?? []).slice(0, MAX_FILES)) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const path = boundedPath(file.path);
    const patch = typeof file.patch === "string" ? safeText(file.patch.slice(0, MAX_INPUT_CHARS)) : "";
    if (patch.length === 0) {
      candidates.push(candidate(file, path, path, ""));
      continue;
    }

    const hunks = hunksOf(patch);
    if (hunks.length === 0) {
      candidates.push(candidate(file, path, path, patch));
      continue;
    }
    for (const hunk of hunks) {
      const labels = labelsFor(path, hunk);
      const selected = labels.length > 0
        ? labels
        : [{ label: coordinateLabel(path, hunk.newStart), line: -1, rawStart: 0, rawEnd: 0 }];
      for (const hit of selected) {
        if (candidates.length >= MAX_CANDIDATES) return candidates;
        const evidence = hit.line < 0 ? hunk.lines.join("\n") : evidenceFor(hunk, hit);
        candidates.push(candidate(file, path, hit.label, evidence));
      }
    }
    // The hunks left out of a cut patch are unseen, so the file stays unresolved for a human.
    if (file.patchTruncated && candidates.length < MAX_CANDIDATES) candidates.push(candidate(file, path, path, ""));
  }
  return candidates;
}
