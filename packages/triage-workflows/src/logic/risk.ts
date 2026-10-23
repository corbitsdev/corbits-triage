import { isDocPath, isGeneratedPath, isTestPath } from "@corbits/triage-contracts/paths";
import { globMatch } from "./glob.js";

/** A commit message that fixes or reverts earlier work. */
export const FIX_MESSAGE = /\b(?:fix|fixes|fixed|hotfix|revert|reverts)\b/i;

/** The changed paths whose history is read: tests, docs and lockfiles churn without regressing anything. */
export function historyPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !isTestPath(path) && !isDocPath(path) && !isGeneratedPath(path));
}

export function fixCount(messages: readonly string[]): number {
  return messages.filter((message) => FIX_MESSAGE.test(message)).length;
}

/** The paths with at least `threshold` fixes, as `path: n recent fixes`. */
export function hotFiles(fixes: ReadonlyMap<string, number>, threshold: number): string[] {
  return [...fixes].filter(([, n]) => n >= threshold).map(([path, n]) => `${path}: ${n} recent fixes`);
}

export function migrationPaths(paths: readonly string[], globs: readonly string[]): string[] {
  return paths.filter((path) => globs.some((glob) => globMatch(path, glob)));
}
