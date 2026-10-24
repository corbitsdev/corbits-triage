export const MAX_LINES = 400;
const MAX_LINE_CHARS = 500;

export function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/** Lines start..end (1-based, inclusive) of `text`, numbered, at most MAX_LINES of them. */
export function linesOf(path: string, text: string, start = 1, end = start + MAX_LINES - 1) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error("start and end must be integers");
  if (start < 1 || end < start) throw new Error(`lines are 1-based and end must be at least start, got ${start}..${end}`);
  if (text.includes("\0")) throw new Error(`${path} is binary`);
  const lines = text.split("\n");
  const to = Math.min(lines.length, end, start + MAX_LINES - 1);
  const numbered = lines.slice(start - 1, to).map((line, i) => `${start + i}\t${clip(line)}`);
  return { path, start, end: to, totalLines: lines.length, text: numbered.join("\n") };
}
