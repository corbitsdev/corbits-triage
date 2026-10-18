import type { DiffLine } from "@corbits/common/patch";

export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

export type PatchedFile = { status: string; additions: number; deletions: number; patch?: string };

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

export function missingPatchReason(file: Omit<PatchedFile, "patch">): string {
  if (file.status === "renamed" && file.additions + file.deletions === 0) return "Renamed without changes.";
  if (file.status === "changed") return "File mode changed.";
  if (file.additions + file.deletions === 0) return "No text changes to show.";
  return "Diff too large to show.";
}
