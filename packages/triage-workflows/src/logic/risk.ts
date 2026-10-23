import { isDocPath, isGeneratedPath, isTestPath } from "@corbits/triage-contracts/paths";
import { globMatch } from "./glob.js";

// Only the subject's type counts: branch commits like "fix lint" or a body mentioning a fix would make every busy file hot.
const FIX_SUBJECT = /^(?:(?:fix|bugfix|hotfix|revert)(?:\([^()]*\))?!?:|revert\b|hotfix\b)/i;

/** A commit whose subject is a conventional fix, bugfix, hotfix or revert; merges are not. */
export function isFix(message: string): boolean {
  return FIX_SUBJECT.test(message.split("\n", 1)[0]!.trim());
}

/** The changed paths whose history is read: tests, docs and lockfiles churn without regressing anything. */
export function historyPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !isTestPath(path) && !isDocPath(path) && !isGeneratedPath(path));
}

export function fixCount(messages: readonly string[]): number {
  return messages.filter(isFix).length;
}

const HOT_SHOWN = 3;

/** The hottest paths with at least `threshold` fixes, as `path: n recent fixes`, then how many more there are. */
export function hotFiles(fixes: ReadonlyMap<string, number>, threshold: number): string[] {
  const hot = [...fixes].filter(([, n]) => n >= threshold).sort((a, b) => b[1] - a[1]);
  const shown = hot.slice(0, HOT_SHOWN).map(([path, n]) => `${path}: ${n} recent fixes`);
  return hot.length > HOT_SHOWN ? [...shown, `and ${hot.length - HOT_SHOWN} more`] : shown;
}

export function migrationPaths(paths: readonly string[], globs: readonly string[]): string[] {
  return paths.filter((path) => globs.some((glob) => globMatch(path, glob)));
}
