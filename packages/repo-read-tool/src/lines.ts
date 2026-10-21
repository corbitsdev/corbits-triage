export const MAX_LINES = 400;
const MAX_LINE_CHARS = 500;

export function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/** Lines start..end (1-based, inclusive) of `text`, numbered, at most MAX_LINES of them. */
export function linesOf(path: string, text: string, start = 1, end = start + MAX_LINES - 1) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error("start and end must be integers");
  if (text.includes("\0")) throw new Error(`${path} is binary`);
  const lines = text.split("\n");
  const from = Math.max(1, start);
  const to = Math.min(lines.length, end, from + MAX_LINES - 1);
  const numbered = lines.slice(from - 1, to).map((line, i) => `${from + i}\t${clip(line)}`);
  return { path, start: from, end: to, totalLines: lines.length, text: numbered.join("\n") };
}
