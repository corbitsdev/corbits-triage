export const MAX_LINES = 400;
const MAX_LINE_CHARS = 500;
// Interchange cuts a tool result whose JSON is over 10,000 characters to a plain string the reader cannot count as
// lines read; its limit is not exported, so a page stops below it with room to spare.
const MAX_RESULT_CHARS = 9_000;

export function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

function jsonLength(text: string): number {
  return JSON.stringify(text).length - 2;
}

/**
 * Lines start..end (1-based, inclusive) of `text`, numbered, at most MAX_LINES of them and only as many whole lines as
 * keep the result's JSON within MAX_RESULT_CHARS; `end` is the last line returned.
 */
export function linesOf(path: string, text: string, start = 1, end = start + MAX_LINES - 1) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error("start and end must be integers");
  if (start < 1 || end < start) throw new Error(`lines are 1-based and end must be at least start, got ${start}..${end}`);
  if (text.includes("\0")) throw new Error(`${path} is binary`);
  const lines = text.split("\n");
  let to = Math.min(lines.length, end, start + MAX_LINES - 1);
  const numbered: string[] = [];
  let size = JSON.stringify({ path, start, end: to, totalLines: lines.length, text: "" }).length;
  for (let n = start; n <= to; n++) {
    const row = `${n}\t${clip(lines[n - 1]!)}`;
    size += jsonLength(row) + (numbered.length > 0 ? jsonLength("\n") : 0);
    if (size > MAX_RESULT_CHARS && numbered.length > 0) {
      to = n - 1;
      break;
    }
    numbered.push(row);
  }
  return { path, start, end: to, totalLines: lines.length, text: numbered.join("\n") };
}
