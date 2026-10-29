import type { ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import { parsePatch } from "@corbits/common/patch";
import { samePath } from "./findings.js";

/** The head-side lines a reader was shown, by path. */
export type LinesRead = Map<string, Set<number>>;

const FileWindow = type({ path: "string", text: "string" });
const GrepMatches = type({ matches: type({ path: "string", line: "number" }).array() });

// The check's message carries the hunks that change the finding's lines, tagged with their file.
const DIFF_TAG = /<diff path="([^"]*)">\n([\s\S]*?)\n<\/diff>/g;
const CITATION = /([^\s`'"(),:]+):(\d+)/g;

function see(read: LinesRead, path: string, line: number) {
  const lines = read.get(path) ?? new Set<number>();
  lines.add(line);
  read.set(path, lines);
}

/** The head-side lines of the diff hunks an input message shows. */
export function linesShown(content: string): LinesRead {
  const read: LinesRead = new Map();
  for (const [, path, hunks] of content.matchAll(DIFF_TAG)) {
    for (const line of parsePatch(hunks!).flatMap((hunk) => hunk.lines)) if (line.newNo !== null) see(read, path!.replaceAll("&quot;", '"'), line.newNo);
  }
  return read;
}

/** Adds the lines a read_file window showed; whether the result was one. */
export function addWindow(read: LinesRead, result: ToolResult): boolean {
  if (result.isError) return false;
  const window = FileWindow(result.content);
  if (window instanceof type.errors) return false;
  for (const row of window.text.split("\n")) {
    const line = Number(row.slice(0, row.indexOf("\t")));
    if (Number.isInteger(line) && line > 0) see(read, window.path, line);
  }
  return true;
}

/** Adds the lines a read_file window or grep matches showed. */
export function addRead(read: LinesRead, result: ToolResult) {
  if (result.isError || addWindow(read, result)) return;
  const grep = GrepMatches(result.content);
  if (!(grep instanceof type.errors)) for (const match of grep.matches) see(read, match.path, match.line);
}

/** Whether the text cites, as path:line, a line that was read. */
export function citesLineRead(text: string, read: LinesRead): boolean {
  return [...text.matchAll(CITATION)].some(([, path, line]) => [...read].some(([readPath, lines]) => samePath(path!, readPath) && lines.has(Number(line))));
}
