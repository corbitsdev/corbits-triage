import { createHash } from "node:crypto";

/**
 * The diff's hash, its `index` lines' blob ids included, so a base change to a file the diff touches changes it; undefined
 * for a diff with no `index` line, such as one rebuilt from the file list, which can't show such a change.
 */
export function diffHash(diff: string): string | undefined {
  if (!diff.split("\n").some((line) => line.startsWith("index "))) return undefined;
  return createHash("sha256").update(diff).digest("hex");
}
