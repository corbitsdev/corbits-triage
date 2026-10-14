import type { CheckResult } from "@corbits/triage-workflows/logic/checks";

export type FileNote = { path: string; line?: number; check: string; reason: string };

type NamedCheck = CheckResult & { name: string };

/** The files and added lines a failing rule cites, to mark in the Files tab. */
export function fileNotes(checks: NamedCheck[]): FileNote[] {
  const notes: FileNote[] = [];
  for (const check of checks.filter((each) => each.result === "fail")) {
    if (check.check === "no-forbidden-paths") {
      for (const path of check.evidence) notes.push({ path, check: check.name, reason: "Touches a protected path." });
    }
    const items = "items" in check.output ? check.output.items ?? [] : [];
    for (const item of items) {
      if (typeof item !== "string" && item.added) notes.push({ path: item.path, line: item.added.start, check: check.name, reason: check.reason });
    }
  }
  return notes;
}
