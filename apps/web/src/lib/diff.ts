export type DiffLine = {
  kind: "add" | "del" | "ctx";
  oldNo: number | null;
  newNo: number | null;
  text: string;
  noNewline?: true;
};

export type DiffHunk = { header: string; lines: DiffLine[] };

export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

export type PatchedFile = { status: string; additions: number; deletions: number; patch?: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses a GitHub unified patch (hunks only, no file headers) into hunks of numbered lines. */
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

/** Pairs a hunk's lines for side-by-side display: each run of removals sits beside the additions that follow it. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  function flush() {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
    }
    removed = [];
    added = [];
  }
  for (const line of lines) {
    if (line.kind === "ctx") {
      flush();
      rows.push({ left: line, right: line });
    } else if (line.kind === "del") {
      if (added.length > 0) flush();
      removed.push(line);
    } else {
      added.push(line);
    }
  }
  flush();
  return rows;
}

/** Why GitHub sent no patch for a file. */
export function missingPatchReason(file: Omit<PatchedFile, "patch">): string {
  if (file.status === "renamed" && file.additions + file.deletions === 0) return "Renamed without changes.";
  if (file.status === "changed") return "File mode changed.";
  if (file.additions + file.deletions === 0) return "No text changes to show.";
  return "Diff too large to show.";
}
