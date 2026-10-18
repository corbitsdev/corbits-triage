export type DiffLine = {
  kind: "add" | "del" | "ctx";
  oldNo: number | null;
  newNo: number | null;
  text: string;
  noNewline?: true;
};

export type DiffHunk = { header: string; lines: DiffLine[] };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.replace(/\n$/, "").split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      hunk = { header: raw, lines: [] };
      hunks.push(hunk);
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      continue;
    }
    if (!hunk) throw new Error(`patch line before the first hunk header: ${raw}`);
    if (raw.startsWith("\\")) {
      const last = hunk.lines.at(-1);
      if (last) last.noNewline = true;
      continue;
    }
    const text = raw.slice(1);
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text });
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
    } else if (raw === "" || raw.startsWith(" ")) {
      hunk.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text });
    } else {
      throw new Error(`unrecognised patch line: ${raw}`);
    }
  }
  return hunks;
}
